import { PassThrough } from "stream";
import path from "path";
import _ from "lodash";
import mime from "mime";
import axios, { AxiosResponse } from "axios";

import APIException from "@/lib/exceptions/APIException.ts";
import EX from "@/api/consts/exceptions.ts";
import { createParser } from "eventsource-parser";
import logger from "@/lib/logger.ts";
import util from "@/lib/util.ts";

// 模型名称
const MODEL_NAME = "qwen";
// 最大重试次数
const MAX_RETRY_COUNT = 0;
// 重试延迟
const RETRY_DELAY = 5000;
// 伪装headers
const FAKE_HEADERS = {
  Accept: "application/json, text/plain, */*",
  "Accept-Encoding": "gzip, deflate, br, zstd",
  "Accept-Language": "zh-CN,zh;q=0.9",
  "Cache-Control": "no-cahce",
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
  "X-Xsrf-Token": "4506064f-1da8-4d22-a004-b36092db2789",
};
// 文件最大大小
const FILE_MAX_SIZE = 100 * 1024 * 1024;

/**
 * 移除会话
 *
 * 在对话流传输完毕后移除会话，避免创建的会话出现在用户的对话列表中
 *
 * @param ticket login_tongyi_ticket值
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
        ...FAKE_HEADERS
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
 * @param ticket login_tongyi_ticket值
 * @param retryCount 重试次数
 */
async function createCompletion(
  model = MODEL_NAME,
  messages: any[],
  ticket: string,
  retryCount = 0
) {
  return (async () => {
    logger.info(messages);

    // 提取引用文件URL并上传qwen获得引用的文件ID列表
    const refFileUrls = extractRefFileUrls(messages);
    // const refs = refFileUrls.length
    //   ? await Promise.all(
    //       refFileUrls.map((fileUrl) => uploadFile(fileUrl, ticket))
    //     )
    //   : [];

    // 创建会话并获得流
    const result = await axios.post(
      "https://qianwen.biz.aliyun.com/dialog/conversation",
      {
        model: "",
        action: "next",
        mode: "chat",
        userAction: "chat",
        requestId: util.uuid(false),
        sessionId: "",
        sessionType: "text_chat",
        parentMsgId: "",
        contents: messagesPrepare(messages),
      },
      {
        headers: {
          Cookie: generateCookie(ticket),
          ...FAKE_HEADERS,
        },
        timeout: 120000,
        validateStatus: () => true,
        responseType: "stream",
      }
    );
    const streamStartTime = util.timestamp();
    // 接收流为输出文本
    const answer = await receiveStream(result.data);
    logger.success(
      `Stream has completed transfer ${util.timestamp() - streamStartTime}ms`
    );

    // 异步移除会话，如果消息不合规，此操作可能会抛出数据库错误异常，请忽略
    removeConversation(answer.id, ticket).catch((err) =>
      console.error(err)
    );

    return answer;
  })().catch((err) => {
    if (retryCount < MAX_RETRY_COUNT) {
      logger.error(`Stream response error: ${err.message}`);
      logger.warn(`Try again after ${RETRY_DELAY / 1000}s...`);
      return (async () => {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
        return createCompletion(model, messages, ticket, retryCount + 1);
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
 * @param ticket login_tongyi_ticket值
 * @param useSearch 是否开启联网搜索
 * @param retryCount 重试次数
 */
async function createCompletionStream(
  model = MODEL_NAME,
  messages: any[],
  ticket: string,
  retryCount = 0
) {
  return (async () => {
    logger.info(messages);

    // 提取引用文件URL并上传qwen获得引用的文件ID列表
    const refFileUrls = extractRefFileUrls(messages);
    // const refs = refFileUrls.length
    //   ? await Promise.all(
    //       refFileUrls.map((fileUrl) => uploadFile(fileUrl, ticket))
    //     )
    //   : [];

    // 请求流
    const result = await axios.post(
      "https://qianwen.biz.aliyun.com/dialog/conversation",
      {
        model: "",
        action: "next",
        mode: "chat",
        userAction: "chat",
        requestId: util.uuid(false),
        sessionId: "",
        sessionType: "text_chat",
        parentMsgId: "",
        contents: messagesPrepare(messages),
      },
      {
        headers: {
          Cookie: generateCookie(ticket),
          ...FAKE_HEADERS,
        },
        timeout: 120000,
        validateStatus: () => true,
        responseType: "stream",
      }
    );
    const streamStartTime = util.timestamp();
    // 创建转换流将消息格式转换为gpt兼容格式
    return createTransStream(result.data, (convId: string) => {
      logger.success(
        `Stream has completed transfer ${util.timestamp() - streamStartTime}ms`
      );
      // 流传输结束后异步移除会话，如果消息不合规，此操作可能会抛出数据库错误异常，请忽略
      removeConversation(convId, ticket).catch((err) =>
        console.error(err)
      );
    });
  })().catch((err) => {
    if (retryCount < MAX_RETRY_COUNT) {
      logger.error(`Stream response error: ${err.message}`);
      logger.warn(`Try again after ${RETRY_DELAY / 1000}s...`);
      return (async () => {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
        return createCompletionStream(
          model,
          messages,
          ticket,
          retryCount + 1
        );
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
  return messages.reduce((urls, message) => {
    if (_.isArray(message.content)) {
      message.content.forEach((v) => {
        if (!_.isObject(v) || !["file", "image_url"].includes(v["type"]))
          return;
        // qwen-free-api支持格式
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
    return urls;
  }, []);
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
 */
function messagesPrepare(messages: any[]) {
  const content = messages.reduce((content, message) => {
    if (_.isArray(message.content)) {
      return message.content.reduce((_content, v) => {
        if (!_.isObject(v) || v["type"] != "text") return _content;
        return _content + (v["text"] || "");
      }, content);
    }
    return (content += `<|im_start|>${message.role || "user"}\n${message.content}<|im_end|>\n`);
  }, "");
  return [{
    role: "user",
    contentType: "text",
    content
  }];
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
    let textOffset = 0;
    const parser = createParser((event) => {
      try {
        if (event.type !== "event") return;
        if (event.data == "[DONE]") return;
        // 解析JSON
        const result = _.attempt(() => JSON.parse(event.data));
        if (_.isError(result))
          throw new Error(`Stream response invalid: ${event.data}`);
        console.log(result)
        if (!data.id && result.sessionId) data.id = result.sessionId;
        if (result.msgStatus != "finished") {
          const text = (result.contents || []).reduce((str, part) => {
            const { role, content } = part;
            if (role != "assistant" && !_.isString(content)) return str;
            return str + content;
          }, "");
          const chunk = text.substring(
            data.choices[0].message.content.length - textOffset,
            text.length
          );
          data.choices[0].message.content += chunk;
        } else {
          if(!result.canShare)
            data.choices[0].message.content += '\n[内容由于不合规被停止生成，我们换个话题吧]';
          if(result.errorCode)
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
  let content = '';
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
      if (result.msgStatus != "finished") {
        const text = (result.contents || []).reduce((str, part) => {
          const { role, content } = part;
          if (role != "assistant" && !_.isString(content)) return str;
          return str + content;
        }, "");
        const chunk = text.substring(content.length, text.length);
        if(chunk) {
          content += chunk;
          const data = `data: ${JSON.stringify({
            id: result.conversation_id,
            model: MODEL_NAME,
            object: 'chat.completion.chunk',
            choices: [
              { index: 0, delta: { content: chunk }, finish_reason: null }
            ],
            created
          })}\n\n`;
          !transStream.closed && transStream.write(data);
        }
      } else {
        let delta = {};
        if(!result.canShare)
          delta = { content: '\n[内容由于不合规被停止生成，我们换个话题吧]' }
        if(result.errorCode)
          delta = { content: `服务暂时不可用，第三方响应错误：${result.errorCode}` };
        const data = `data: ${JSON.stringify({
          id: result.conversation_id,
          model: MODEL_NAME,
          object: 'chat.completion.chunk',
          choices: [
            {
              index: 0,
              delta,
              finish_reason: 'stop'
            }
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          created
        })}\n\n`;
        !transStream.closed && transStream.write(data);
        !transStream.closed && transStream.end('data: [DONE]\n\n');
        content = '';
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
  return transStream;
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
 * @param ticket login_tongyi_ticket值
 */
function generateCookie(ticket: string) {
  return [
    // `login_aliyunid_csrf=_csrf_tk_1338411200877960`,
    // '_samesite_flag_=true',
    // 'cookie2=17f5d8b4b310ced751b4884bf6f90a59',
    // `munb=2205561979317`,
    // `csg=d2a7667c`,
    // `t=b147e56818bb17773dbbac0b0f5124d4`,
    // `_tb_token_=e0e1e0eaf6397`,
    `login_tongyi_ticket=${ticket}`,
    // `cna=2BIPGQLBaUoCAXF0dTVJX4J7`,
    // `cnaui=1717007863755884`,
    // `atpsida=96034589ac4b10f25d62eeb3_1711200918_2`,
    // `isg=BJeXsmIBvhDupD4W9uGbnvw8Jg3h3Gs-fDl6NunHdWZIGLxa9a2mj8r6e7gGxkO2`,
    // `tfstk=crDFBRcFK801Valh3RezgJtCWRxdaCMmeNr7teNJ-WUBJiF8usY1ylAoB5PfbaVh.`,
    // `aui=1717007863755884`,
    // `sca=48fca504`
  ].join('; ');
}

export default {
  createCompletion,
  createCompletionStream,
  tokenSplit,
};
