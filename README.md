# Qwen AI Free 服务

![](https://img.shields.io/github/license/llm-red-team/qwen-free-api.svg)
![](https://img.shields.io/github/stars/llm-red-team/qwen-free-api.svg)
![](https://img.shields.io/github/forks/llm-red-team/qwen-free-api.svg)
![](https://img.shields.io/docker/pulls/vinlic/qwen-free-api.svg)

支持高速流式输出、支持多轮对话、支持长文档解读、支持图像解析，零配置部署，多路token支持，自动清理会话痕迹。

与ChatGPT接口完全兼容。

还有以下三个free-api欢迎关注：

Moonshot AI（Kimi.ai）接口转API [kimi-free-api](https://github.com/LLM-Red-Team/kimi-free-api)

ZhipuAI (智谱清言) 接口转API [glm-free-api](https://github.com/LLM-Red-Team/glm-free-api)

聆心智能 (Emohaa) 接口转API [emohaa-free-api](https://github.com/LLM-Red-Team/emohaa-free-api)

还在完善文档解读和图像解析功能，目前流式接口已开放，接入请从 [通义千问](https://tongyi.aliyun.com/qianwen) 登录并从Cookie获取`login_tongyi_ticket`值作为Authorization头的API_KEY值：

Authorization: Bearer [login_tongyi_ticket]

文档将在后续完善。