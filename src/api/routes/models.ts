import _ from 'lodash';

export default {

    prefix: '/v1',

    get: {
        '/models': async () => {
            return {
                "data": [
                    {
                        "id": "qwen-max",
                        "object": "model",
                        "owned_by": "qwen-free-api"
                    },
                    {
                        "id": "qwen-max-longcontext",
                        "object": "model",
                        "owned_by": "qwen-free-api"
                    },
                    {
                        "id": "qwen-plus",
                        "object": "model",
                        "owned_by": "qwen-free-api"
                    },
                    {
                        "id": "qwen-turbo",
                        "object": "model",
                        "owned_by": "qwen-free-api"
                    },
                    {
                        "id": "qwen-vl-max",
                        "object": "model",
                        "owned_by": "qwen-free-api"
                    },
                    {
                        "id": "qwen-vl-plus",
                        "object": "model",
                        "owned_by": "qwen-free-api"
                    },
                    {
                        "id": "qwen-v1",
                        "object": "model",
                        "owned_by": "qwen-free-api"
                    },
                    {
                        "id": "qwen-v1-vision",
                        "object": "model",
                        "owned_by": "qwen-free-api"
                    }
                ]
            };
        }

    }
}