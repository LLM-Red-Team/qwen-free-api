import { URL } from "url";
import { PassThrough } from "stream";
import http2 from "http2";
import path from "path";
import _ from "lodash";
import mime from "mime";
import FormData from "form-data";
import axios, { AxiosResponse } from "axios";

import APIException from "@/lib/exceptions/APIException.ts";
import EX from "@/api/consts/exceptions.ts";
import { createParser } from "eventsource-parser";
import logger from "@/lib/logger.ts";
import util from "@/lib/util.ts";

// 模型名称
const MODEL_NAME = "qwen";
// 最大重试次数
const MAX_RETRY_COUNT = 3;
// 重试延迟
const RETRY_DELAY = 5000;
// 伪装headers
const FAKE_HEADERS = {
  Accept: "application/json, text/plain, */*",
  "Accept-Encoding": "gzip, deflate, br, zstd",
  "Accept-Language": "zh-CN,zh;q=0.9",
  "Cache-Control": "no-cache",
  Origin: "https://tongyi.aliyun.com",
  Pragma: "no-cache",
  "Sec-Ch-Ua":
    '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
  "Sec-Ch-Ua-Mobile": "?0",
  "Sec-Ch-Ua-Platform": '"Windows"',
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "same-site",
  Referer: "https://tongyi.aliyun.com/",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "X-Platform": "pc_tongyi",
  "X-Xsrf-Token": "48b9ee49-a184-45e2-9f67-fa87213edcdc",
};
// 文件最大大小
const FILE_MAX_SIZE = 100 * 1024 * 1024;

/**
 * 移除会话
 *
 * 在对话流传输完毕后移除会话，避免创建的会话出现在用户的对话列表中
 *
 * @param ticket tongyi_sso_ticket或login_aliyunid_ticket
 */
async function removeConversation(convId: string, ticket: string) {
  const result = await axios.post(
    `https://qianwen.biz.aliyun.com/dialog/session/delete`,
    {
      sessionId: convId,
    },
    {
      headers: {
        Cookie: generateCookie(ticket),
        ...FAKE_HEADERS,
      },
      timeout: 15000,
      validateStatus: () => true,
    }
  );
  checkResult(result);
}

/**
 * 同步对话补全
 *
 * @param model 模型名称
 * @param messages 参考gpt系列消息格式，多轮对话请完整提供上下文
 * @param ticket tongyi_sso_ticket或login_aliyunid_ticket
 * @param refConvId 引用的会话ID
 * @param retryCount 重试次数
 */
async function createCompletion(
  model = MODEL_NAME,
  messages: any[],
  ticket: string,
  refConvId = '',
  retryCount = 0
) {
  let session: http2.ClientHttp2Session;
  return (async () => {
    logger.info(messages);

    // 提取引用文件URL并上传qwen获得引用的文件ID列表
    const refFileUrls = extractRefFileUrls(messages);
    const refs = refFileUrls.length
      ? await Promise.all(
          refFileUrls.map((fileUrl) => uploadFile(fileUrl, ticket))
        )
      : [];

    // 如果引用对话ID不正确则重置引用
    if (!/[0-9a-z]{32}/.test(refConvId))
      refConvId = '';

    // 请求流
    const session: http2.ClientHttp2Session = await new Promise(
      (resolve, reject) => {
        const session = http2.connect("https://qianwen.biz.aliyun.com");
        session.on("connect", () => resolve(session));
        session.on("error", reject);
      }
    );
    const [sessionId, parentMsgId = ''] = refConvId.split('-');
    const req = session.request({
      ":method": "POST",
      ":path": "/dialog/conversation",
      "Content-Type": "application/json",
      Cookie: generateCookie(ticket),
      ...FAKE_HEADERS,
      Accept: "text/event-stream",
    });
    req.setTimeout(120000);
    req.write(
      JSON.stringify({
        mode: "chat",
        model: "",
        action: "next",
        userAction: "chat",
        requestId: util.uuid(false),
        sessionId,
        sessionType: "text_chat",
        parentMsgId,
        params: {
          "fileUploadBatchId": util.uuid()
        },
        contents: messagesPrepare(messages, refs, !!refConvId),
      })
    );
    req.setEncoding("utf8");
    const streamStartTime = util.timestamp();
    // 接收流为输出文本
    const answer = await receiveStream(req);
    session.close();
    logger.success(
      `Stream has completed transfer ${util.timestamp() - streamStartTime}ms`
    );

    // 异步移除会话，如果消息不合规，此操作可能会抛出数据库错误异常，请忽略
    removeConversation(answer.id, ticket).catch((err) => console.error(err));

    return answer;
  })().catch((err) => {
    session && session.close();
    if (retryCount < MAX_RETRY_COUNT) {
      logger.error(`Stream response error: ${err.message}`);
      logger.warn(`Try again after ${RETRY_DELAY / 1000}s...`);
      return (async () => {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
        return createCompletion(model, messages, ticket, refConvId, retryCount + 1);
      })();
    }
    throw err;
  });
}

/**
 * 流式对话补全
 *
 * @param model 模型名称
 * @param messages 参考gpt系列消息格式，多轮对话请完整提供上下文
 * @param ticket tongyi_sso_ticket或login_aliyunid_ticket
 * @param refConvId 引用的会话ID
 * @param retryCount 重试次数
 */
async function createCompletionStream(
  model = MODEL_NAME,
  messages: any[],
  ticket: string,
  refConvId = '',
  retryCount = 0
) {
  let session: http2.ClientHttp2Session;
  return (async () => {
    logger.info(messages);

    // 提取引用文件URL并上传qwen获得引用的文件ID列表
    const refFileUrls = extractRefFileUrls(messages);
    const refs = refFileUrls.length
      ? await Promise.all(
          refFileUrls.map((fileUrl) => uploadFile(fileUrl, ticket))
        )
      : [];

    // 如果引用对话ID不正确则重置引用
    if (!/[0-9a-z]{32}/.test(refConvId))
      refConvId = ''

    // 请求流
    session = await new Promise((resolve, reject) => {
      const session = http2.connect("https://qianwen.biz.aliyun.com");
      session.on("connect", () => resolve(session));
      session.on("error", reject);
    });
    const [sessionId, parentMsgId = ''] = refConvId.split('-');
    const req = session.request({
      ":method": "POST",
      ":path": "/dialog/conversation",
      "Content-Type": "application/json",
      Cookie: generateCookie(ticket),
      ...FAKE_HEADERS,
      Accept: "text/event-stream",
    });
    req.setTimeout(120000);
    req.write(
      JSON.stringify({
        mode: "chat",
        model: "",
        action: "next",
        userAction: "chat",
        requestId: util.uuid(false),
        sessionId,
        sessionType: "text_chat",
        parentMsgId,
        params: {
          "fileUploadBatchId": util.uuid()
        },
        contents: messagesPrepare(messages, refs, !!refConvId),
      })
    );
    req.setEncoding("utf8");
    const streamStartTime = util.timestamp();
    // 创建转换流将消息格式转换为gpt兼容格式
    return createTransStream(req, (convId: string) => {
      // 关闭请求会话
      session.close();
      logger.success(
        `Stream has completed transfer ${util.timestamp() - streamStartTime}ms`
      );
      // 流传输结束后异步移除会话，如果消息不合规，此操作可能会抛出数据库错误异常，请忽略
      removeConversation(convId, ticket).catch((err) => console.error(err));
    });
  })().catch((err) => {
    session && session.close();
    if (retryCount < MAX_RETRY_COUNT) {
      logger.error(`Stream response error: ${err.message}`);
      logger.warn(`Try again after ${RETRY_DELAY / 1000}s...`);
      return (async () => {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
        return createCompletionStream(model, messages, ticket, refConvId, retryCount + 1);
      })();
    }
    throw err;
  });
}

async function generateImages(
  model = MODEL_NAME,
  prompt: string,
  ticket: string,
  retryCount = 0
) {
  let session: http2.ClientHttp2Session;
  return (async () => {
    const messages = [
      { role: "user", content: prompt.indexOf('画') == -1 ? `请画：${prompt}` : prompt },
    ];
    // 请求流
    const session: http2.ClientHttp2Session = await new Promise(
      (resolve, reject) => {
        const session = http2.connect("https://qianwen.biz.aliyun.com");
        session.on("connect", () => resolve(session));
        session.on("error", reject);
      }
    );
    const req = session.request({
      ":method": "POST",
      ":path": "/dialog/conversation",
      "Content-Type": "application/json",
      Cookie: generateCookie(ticket),
      ...FAKE_HEADERS,
      Accept: "text/event-stream",
    });
    req.setTimeout(120000);
    req.write(
      JSON.stringify({
        mode: "chat",
        model: "",
        action: "next",
        userAction: "chat",
        requestId: util.uuid(false),
        sessionId: "",
        sessionType: "text_chat",
        parentMsgId: "",
        params: {
          "fileUploadBatchId": util.uuid()
        },
        contents: messagesPrepare(messages),
      })
    );
    req.setEncoding("utf8");
    const streamStartTime = util.timestamp();
    // 接收流为输出文本
    const { convId, imageUrls } = await receiveImages(req);
    session.close();
    logger.success(
      `Stream has completed transfer ${util.timestamp() - streamStartTime}ms`
    );

    // 异步移除会话，如果消息不合规，此操作可能会抛出数据库错误异常，请忽略
    removeConversation(convId, ticket).catch((err) => console.error(err));

    return imageUrls;
  })().catch((err) => {
    session && session.close();
    if (retryCount < MAX_RETRY_COUNT) {
      logger.error(`Stream response error: ${err.message}`);
      logger.warn(`Try again after ${RETRY_DELAY / 1000}s...`);
      return (async () => {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
        return generateImages(model, prompt, ticket, retryCount + 1);
      })();
    }
    throw err;
  });
}

/**
 * 提取消息中引用的文件URL
 *
 * @param messages 参考gpt系列消息格式，多轮对话请完整提供上下文
 */
function extractRefFileUrls(messages: any[]) {
  const urls = [];
  // 如果没有消息，则返回[]
  if (!messages.length) {
    return urls;
  }
  // 只获取最新的消息
  const lastMessage = messages[messages.length - 1];
  if (_.isArray(lastMessage.content)) {
    lastMessage.content.forEach((v) => {
      if (!_.isObject(v) || !["file", "image_url"].includes(v["type"])) return;
      // glm-free-api支持格式
      if (
        v["type"] == "file" &&
        _.isObject(v["file_url"]) &&
        _.isString(v["file_url"]["url"])
      )
        urls.push(v["file_url"]["url"]);
      // 兼容gpt-4-vision-preview API格式
      else if (
        v["type"] == "image_url" &&
        _.isObject(v["image_url"]) &&
        _.isString(v["image_url"]["url"])
      )
        urls.push(v["image_url"]["url"]);
    });
  }
  logger.info("本次请求上传：" + urls.length + "个文件");
  return urls;
}

/**
 * 消息预处理
 *
 * 由于接口只取第一条消息，此处会将多条消息合并为一条，实现多轮对话效果
 * user:旧消息1
 * assistant:旧消息2
 * user:新消息
 *
 * @param messages 参考gpt系列消息格式，多轮对话请完整提供上下文
 * @param refs 参考文件列表
 * @param isRefConv 是否为引用会话
 */
function messagesPrepare(messages: any[], refs: any[] = [], isRefConv = false) {
  let content;
  if (isRefConv || messages.length < 2) {
    content = messages.reduce((content, message) => {
      if (_.isArray(message.content)) {
        return (
          message.content.reduce((_content, v) => {
            if (!_.isObject(v) || v["type"] != "text") return _content;
            return _content + (v["text"] || "") + "\n";
          }, content)
        );
      }
      return content + `${message.content}\n`;
    }, "");
    logger.info("\n透传内容：\n" + content);
  }
  else {
    content = messages.reduce((content, message) => {
      if (_.isArray(message.content)) {
        return message.content.reduce((_content, v) => {
          if (!_.isObject(v) || v["type"] != "text") return _content;
          return _content + `<|im_start|>${message.role || "user"}\n${v["text"] || ""}<|im_end|>\n`;
        }, content);
      }
      return (content += `<|im_start|>${message.role || "user"}\n${
        message.content
      }<|im_end|>\n`);
    }, "").replace(/\!\[.*\]\(.+\)/g, "");
    logger.info("\n对话合并：\n" + content);
  }
  return [
    {
      content,
      contentType: "text",
      role: "user",
    },
    ...refs
  ];
}

/**
 * 检查请求结果
 *
 * @param result 结果
 */
function checkResult(result: AxiosResponse) {
  if (!result.data) return null;
  const { success, errorCode, errorMsg } = result.data;
  if (!_.isBoolean(success) || success) return result.data;
  throw new APIException(
    EX.API_REQUEST_FAILED,
    `[请求qwen失败]: ${errorCode}-${errorMsg}`
  );
}

/**
 * 从流接收完整的消息内容
 *
 * @param stream 消息流
 */
async function receiveStream(stream: any): Promise<any> {
  return new Promise((resolve, reject) => {
    // 消息初始化
    const data = {
      id: "",
      model: MODEL_NAME,
      object: "chat.completion",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      created: util.unixTimestamp(),
    };
    const parser = createParser((event) => {
      try {
        if (event.type !== "event") return;
        if (event.data == "[DONE]") return;
        // 解析JSON
        const result = _.attempt(() => JSON.parse(event.data));
        if (_.isError(result))
          throw new Error(`Stream response invalid: ${event.data}`);
        if (!data.id && result.sessionId && result.msgId)
          data.id = `${result.sessionId}-${result.msgId}`;
        const text = (result.contents || []).reduce((str, part) => {
          const { contentType, role, content } = part;
          if (contentType != "text" && contentType != "text2image") return str;
          if (role != "assistant" && !_.isString(content)) return str;
          return str + content;
        }, "");
        const exceptCharIndex = text.indexOf("�");
        let chunk = text.substring(
          exceptCharIndex != -1
            ? Math.min(data.choices[0].message.content.length, exceptCharIndex)
            : data.choices[0].message.content.length,
          exceptCharIndex == -1 ? text.length : exceptCharIndex
        );
        if (chunk && result.contentType == "text2image") {
          chunk = chunk.replace(
            /https?:\/\/[-a-zA-Z0-9@:%._\+~#=]{2,256}\.[a-z]{2,6}\b([-a-zA-Z0-9@:%_\+.~#?&//=\,]*)/gi,
            (url) => {
              const urlObj = new URL(url);
              urlObj.search = "";
              return urlObj.toString();
            }
          );
        }
        if (result.msgStatus != "finished") {
          if (result.contentType == "text")
            data.choices[0].message.content += chunk;
        } else {
          data.choices[0].message.content += chunk;
          if (!result.canShare)
            data.choices[0].message.content +=
              "\n[内容由于不合规被停止生成，我们换个话题吧]";
          if (result.errorCode)
            data.choices[0].message.content += `服务暂时不可用，第三方响应错误：${result.errorCode}`;
          resolve(data);
        }
      } catch (err) {
        logger.error(err);
        reject(err);
      }
    });
    // 将流数据喂给SSE转换器
    stream.on("data", (buffer) => parser.feed(buffer.toString()));
    stream.once("error", (err) => reject(err));
    stream.once("close", () => resolve(data));
    stream.end();
  });
}

/**
 * 创建转换流
 *
 * 将流格式转换为gpt兼容流格式
 *
 * @param stream 消息流
 * @param endCallback 传输结束回调
 */
function createTransStream(stream: any, endCallback?: Function) {
  // 消息创建时间
  const created = util.unixTimestamp();
  // 创建转换流
  const transStream = new PassThrough();
  let content = "";
  !transStream.closed &&
    transStream.write(
      `data: ${JSON.stringify({
        id: "",
        model: MODEL_NAME,
        object: "chat.completion.chunk",
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "" },
            finish_reason: null,
          },
        ],
        created,
      })}\n\n`
    );
  const parser = createParser((event) => {
    try {
      if (event.type !== "event") return;
      if (event.data == "[DONE]") return;
      // 解析JSON
      const result = _.attempt(() => JSON.parse(event.data));
      if (_.isError(result))
        throw new Error(`Stream response invalid: ${event.data}`);
      const text = (result.contents || []).reduce((str, part) => {
        const { contentType, role, content } = part;
        if (contentType != "text" && contentType != "text2image") return str;
        if (role != "assistant" && !_.isString(content)) return str;
        return str + content;
      }, "");
      const exceptCharIndex = text.indexOf("�");
      let chunk = text.substring(
        exceptCharIndex != -1
          ? Math.min(content.length, exceptCharIndex)
          : content.length,
        exceptCharIndex == -1 ? text.length : exceptCharIndex
      );
      if (chunk && result.contentType == "text2image") {
        chunk = chunk.replace(
          /https?:\/\/[-a-zA-Z0-9@:%._\+~#=]{2,256}\.[a-z]{2,6}\b([-a-zA-Z0-9@:%_\+.~#?&//=\,]*)/gi,
          (url) => {
            const urlObj = new URL(url);
            urlObj.search = "";
            return urlObj.toString();
          }
        );
      }
      if (result.msgStatus != "finished") {
        if (chunk && result.contentType == "text") {
          content += chunk;
          const data = `data: ${JSON.stringify({
            id: `${result.sessionId}-${result.msgId}`,
            model: MODEL_NAME,
            object: "chat.completion.chunk",
            choices: [
              { index: 0, delta: { content: chunk }, finish_reason: null },
            ],
            created,
          })}\n\n`;
          !transStream.closed && transStream.write(data);
        }
      } else {
        const delta = { content: chunk || "" };
        if (!result.canShare)
          delta.content += "\n[内容由于不合规被停止生成，我们换个话题吧]";
        if (result.errorCode)
          delta.content += `服务暂时不可用，第三方响应错误：${result.errorCode}`;
        const data = `data: ${JSON.stringify({
          id: `${result.sessionId}-${result.msgId}`,
          model: MODEL_NAME,
          object: "chat.completion.chunk",
          choices: [
            {
              index: 0,
              delta,
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          created,
        })}\n\n`;
        !transStream.closed && transStream.write(data);
        !transStream.closed && transStream.end("data: [DONE]\n\n");
        content = "";
        endCallback && endCallback(result.sessionId);
      }
      // else
      //   logger.warn(result.event, result);
    } catch (err) {
      logger.error(err);
      !transStream.closed && transStream.end("\n\n");
    }
  });
  // 将流数据喂给SSE转换器
  stream.on("data", (buffer) => parser.feed(buffer.toString()));
  stream.once(
    "error",
    () => !transStream.closed && transStream.end("data: [DONE]\n\n")
  );
  stream.once(
    "close",
    () => !transStream.closed && transStream.end("data: [DONE]\n\n")
  );
  stream.end();
  return transStream;
}

/**
 * 从流接收图像
 *
 * @param stream 消息流
 */
async function receiveImages(
  stream: any
): Promise<{ convId: string; imageUrls: string[] }> {
  return new Promise((resolve, reject) => {
    let convId = "";
    const imageUrls = [];
    const parser = createParser((event) => {
      try {
        if (event.type !== "event") return;
        if (event.data == "[DONE]") return;
        // 解析JSON
        const result = _.attempt(() => JSON.parse(event.data));
        if (_.isError(result))
          throw new Error(`Stream response invalid: ${event.data}`);
        if (!convId && result.sessionId) convId = result.sessionId;
        const text = (result.contents || []).reduce((str, part) => {
          const { role, content } = part;
          if (role != "assistant" && !_.isString(content)) return str;
          return str + content;
        }, "");
        if (result.contentFrom == "text2image") {
          const urls =
            text.match(
              /https?:\/\/[-a-zA-Z0-9@:%._\+~#=]{2,256}\.[a-z]{2,6}\b([-a-zA-Z0-9@:%_\+.~#?&//=\,]*)/gi
            ) || [];
          urls.forEach((url) => {
            const urlObj = new URL(url);
            urlObj.search = "";
            const imageUrl = urlObj.toString();
            if (imageUrls.indexOf(imageUrl) != -1) return;
            imageUrls.push(imageUrl);
          });
        }
        if (result.msgStatus == "finished") {
          if (!result.canShare || imageUrls.length == 0)
            throw new APIException(EX.API_CONTENT_FILTERED);
          if (result.errorCode)
            throw new APIException(
              EX.API_REQUEST_FAILED,
              `服务暂时不可用，第三方响应错误：${result.errorCode}`
            );
        }
      } catch (err) {
        logger.error(err);
        reject(err);
      }
    });
    // 将流数据喂给SSE转换器
    stream.on("data", (buffer) => parser.feed(buffer.toString()));
    stream.once("error", (err) => reject(err));
    stream.once("close", () => resolve({ convId, imageUrls }));
    stream.end();
  });
}

/**
 * 获取上传参数
 *
 * @param ticket tongyi_sso_ticket或login_aliyunid_ticket
 */
async function acquireUploadParams(ticket: string) {
  const result = await axios.post(
    "https://qianwen.biz.aliyun.com/dialog/uploadToken",
    {},
    {
      timeout: 15000,
      headers: {
        Cookie: generateCookie(ticket),
        ...FAKE_HEADERS,
      },
      validateStatus: () => true,
    }
  );
  const { data } = checkResult(result);
  return data;
}

/**
 * 预检查文件URL有效性
 *
 * @param fileUrl 文件URL
 */
async function checkFileUrl(fileUrl: string) {
  if (util.isBASE64Data(fileUrl)) return;
  const result = await axios.head(fileUrl, {
    timeout: 15000,
    validateStatus: () => true,
  });
  if (result.status >= 400)
    throw new APIException(
      EX.API_FILE_URL_INVALID,
      `File ${fileUrl} is not valid: [${result.status}] ${result.statusText}`
    );
  // 检查文件大小
  if (result.headers && result.headers["content-length"]) {
    const fileSize = parseInt(result.headers["content-length"], 10);
    if (fileSize > FILE_MAX_SIZE)
      throw new APIException(
        EX.API_FILE_EXECEEDS_SIZE,
        `File ${fileUrl} is not valid`
      );
  }
}

/**
 * 上传文件
 *
 * @param fileUrl 文件URL
 * @param ticket tongyi_sso_ticket或login_aliyunid_ticket
 */
async function uploadFile(fileUrl: string, ticket: string) {
  // 预检查远程文件URL可用性
  await checkFileUrl(fileUrl);

  let filename, fileData, mimeType;
  // 如果是BASE64数据则直接转换为Buffer
  if (util.isBASE64Data(fileUrl)) {
    mimeType = util.extractBASE64DataFormat(fileUrl);
    const ext = mime.getExtension(mimeType);
    filename = `${util.uuid()}.${ext}`;
    fileData = Buffer.from(util.removeBASE64DataHeader(fileUrl), "base64");
  }
  // 下载文件到内存，如果您的服务器内存很小，建议考虑改造为流直传到下一个接口上，避免停留占用内存
  else {
    filename = path.basename(fileUrl);
    ({ data: fileData } = await axios.get(fileUrl, {
      responseType: "arraybuffer",
      // 100M限制
      maxContentLength: FILE_MAX_SIZE,
      // 60秒超时
      timeout: 60000,
    }));
  }

  // 获取文件的MIME类型
  mimeType = mimeType || mime.getType(filename);

  // 获取上传参数
  const { accessId, policy, signature, dir } = await acquireUploadParams(
    ticket
  );

  const formData = new FormData();
  formData.append("OSSAccessKeyId", accessId);
  formData.append("policy", policy);
  formData.append("signature", signature);
  formData.append("key", `${dir}${filename}`);
  formData.append("dir", dir);
  formData.append("success_action_status", "200");
  formData.append("file", fileData, {
    filename,
    contentType: mimeType,
  });

  // 上传文件到OSS
  await axios.request({
    method: "POST",
    url: "https://broadscope-dialogue.oss-cn-beijing.aliyuncs.com/",
    data: formData,
    // 100M限制
    maxBodyLength: FILE_MAX_SIZE,
    // 60秒超时
    timeout: 120000,
    headers: {
      ...FAKE_HEADERS,
      "X-Requested-With": "XMLHttpRequest"
    }
  });

  const isImage = [
    'image/jpeg',
    'image/jpg',
    'image/tiff',
    'image/png',
    'image/bmp',
    'image/gif',
    'image/svg+xml', 
    'image/webp',
    'image/ico',
    'image/heic',
    'image/heif',
    'image/bmp',
    'image/x-icon',
    'image/vnd.microsoft.icon',
    'image/x-png'
  ].includes(mimeType);

  if(isImage) {
    const result = await axios.post(
      "https://qianwen.biz.aliyun.com/dialog/downloadLink",
      {
        fileKey: filename,
        fileType: "image",
        dir
      },
      {
        timeout: 15000,
        headers: {
          Cookie: generateCookie(ticket),
          ...FAKE_HEADERS,
        },
        validateStatus: () => true,
      }
    );
    const { data } = checkResult(result);
    return {
      role: "user",
      contentType: "image",
      content: data.url
    };
  }
  else {
    let result = await axios.post(
      "https://qianwen.biz.aliyun.com/dialog/downloadLink/batch",
      {
        fileKeys: [filename],
        fileType: "file",
        dir
      },
      {
        timeout: 15000,
        headers: {
          Cookie: generateCookie(ticket),
          ...FAKE_HEADERS,
        },
        validateStatus: () => true,
      }
    );
    const { data } = checkResult(result);
    if(!data.results[0] || !data.results[0].url)
      throw new Error(`文件上传失败：${data.results[0] ? data.results[0].errorMsg : '未知错误'}`);
    const url = data.results[0].url;
    const startTime = util.timestamp();
    while(true) {
      result = await axios.post(
        "https://qianwen.biz.aliyun.com/dialog/secResult/batch",
        {
          urls: [url]
        },
        {
          timeout: 15000,
          headers: {
            Cookie: generateCookie(ticket),
            ...FAKE_HEADERS,
          },
          validateStatus: () => true,
        }
      );
      const { data } = checkResult(result);
      if(data.pollEndFlag) {
        if(data.statusList[0] && data.statusList[0].status === 0)
          throw new Error(`文件处理失败：${data.statusList[0].errorMsg || '未知错误'}`);
        break;
      }
      if(util.timestamp() > startTime + 120000)
        throw new Error("文件处理超时：超出120秒");
    }
    return {
      role: "user",
      contentType: "file",
      content: url,
      ext: { fileSize: fileData.byteLength }
    };
  }
}

/**
 * Token切分
 *
 * @param authorization 认证字符串
 */
function tokenSplit(authorization: string) {
  return authorization.replace("Bearer ", "").split(",");
}

/**
 * 生成Cookies
 *
 * @param ticket tongyi_sso_ticket或login_aliyunid_ticket
 */
function generateCookie(ticket: string) {
  return [
    `${ticket.length > 100 ? 'login_aliyunid_ticket' : 'tongyi_sso_ticket'}=${ticket}`,
    'aliyun_choice=intl',
    "_samesite_flag_=true",
    `t=${util.uuid(false)}`,
    // `login_aliyunid_csrf=_csrf_tk_${util.generateRandomString({ charset: 'numeric', length: 15 })}`,
    // `cookie2=${util.uuid(false)}`,
    // `munb=22${util.generateRandomString({ charset: 'numeric', length: 11 })}`,
    // `csg=`,
    // `_tb_token_=${util.generateRandomString({ length: 10, capitalization: 'lowercase' })}`,
    // `cna=`,
    // `cnaui=`,
    // `atpsida=`,
    // `isg=`,
    // `tfstk=`,
    // `aui=`,
    // `sca=`
  ].join("; ");
}

/**
 * 获取Token存活状态
 */
async function getTokenLiveStatus(ticket: string) {
  const result = await axios.post(
    "https://qianwen.biz.aliyun.com/dialog/session/list",
    {},
    {
      headers: {
        Cookie: generateCookie(ticket),
        ...FAKE_HEADERS,
      },
      timeout: 15000,
      validateStatus: () => true,
    }
  );
  try {
    const { data } = checkResult(result);
    return _.isArray(data);
  }
  catch(err) {
    return false;
  }
}

export default {
  createCompletion,
  createCompletionStream,
  generateImages,
  getTokenLiveStatus,
  tokenSplit,
};
