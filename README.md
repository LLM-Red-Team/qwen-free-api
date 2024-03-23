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

## 声明

仅限自用，禁止对外提供服务或商用，避免对官方造成服务压力，否则风险自担！

仅限自用，禁止对外提供服务或商用，避免对官方造成服务压力，否则风险自担！

仅限自用，禁止对外提供服务或商用，避免对官方造成服务压力，否则风险自担！

## 目录

* [声明](#声明)
* [在线体验](#在线体验)
* [接入准备](#接入准备)

## 在线体验

此链接仅临时测试功能，长期使用请自行部署。

https://udify.app/chat/qOXzVl5kkvhQXM8r

## 接入准备

从 [通义千问](https://tongyi.aliyun.com/qianwen) 登录

进入通义千问随便发起一个对话，然后F12打开开发者工具，从Application > Cookies中找到`login_tongyi_ticket`的值，这将作为Authorization的Bearer Token值：`Authorization: Bearer TOKEN`

![获取login_tongyi_ticket](./doc/example-0.png)

文档还在持续完善。