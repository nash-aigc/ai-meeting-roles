"""会议主通道的骨架响应数据（M3 agent 编排接入前的前端联调用）。"""

DEFAULT_ROLES_JSON = [
    {
        "id": "customer",
        "name": "客户",
        "voice": "高晴",
        "color": "sky",
        "enabled": False,
        "defaultEnabled": False,
        "priority": 2,
        "interruptAggressiveness": "high",
        "description": "有顾虑的潜在客户，随时抛出异议，检验你的推销与应变能力",
    },
    {
        "id": "boss",
        "name": "老板",
        "voice": "王新月",
        "color": "amber",
        "enabled": False,
        "defaultEnabled": False,
        "priority": 1,
        "interruptAggressiveness": "medium",
        "description": "管理层视角，直接犀利，复盘式提问，关注结果与风险",
    },
]
