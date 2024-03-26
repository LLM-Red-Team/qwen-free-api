import _ from "lodash";

import Request from "@/lib/request/Request.ts";
import chat from "@/api/controllers/chat.ts";
import util from "@/lib/util.ts";

export default {
  prefix: "/v1/images",

  post: {
    "/generations": async (request: Request) => {
      request
        .validate("body.prompt", _.isString)
        .validate("headers.authorization", _.isString);
      // refresh_token切分
      const tokens = chat.tokenSplit(request.headers.authorization);
      // 随机挑选一个refresh_token
      const token = _.sample(tokens);
      const prompt = request.body.prompt;
      const responseFormat = _.defaultTo(request.body.response_format, "url");
      const model = request.body.model;
      const imageUrls = await chat.generateImages(model, prompt, token);
      let data = [];
      if (responseFormat == "b64_json") {
        data = (
          await Promise.all(imageUrls.map((url) => util.fetchFileBASE64(url)))
        ).map((b64) => ({ b64_json: b64 }));
      } else {
        data = imageUrls.map((url) => ({
          url,
        }));
      }
      return {
        created: util.unixTimestamp(),
        data,
      };
    },
  },
};
