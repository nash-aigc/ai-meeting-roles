"""端到端链路探测：gateway -> RoleAgent(真实 Claude CLI) -> agent 事件回传。
先 config.update 把角色思考间隔压到最小(2s)，再 meeting.start + user.speech，等 agent 事件。
"""
import asyncio, json, sys

sys.path.insert(0, "scripts")
import websockets  # noqa: E402

URL = "ws://127.0.0.1:8787/ws/meeting"
HDRS = {"Origin": "http://localhost:5173"}

async def main():
    async with websockets.connect(URL, extra_headers=HDRS) as ws:
        # 等初始角色列表
        while True:
            m = json.loads(await asyncio.wait_for(ws.recv(), 5))
            if m.get("type") == "roles.list":
                roles = m.get("roles", [])
                print("roles:", [(r["id"], r.get("thinkIntervalSec")) for r in roles])
                ids = [r["id"] for r in roles]
                break
        # 压缩思考间隔到 2s
        await ws.send(json.dumps({
            "type": "config.update",
            "patch": {"roles": [{"id": rid, "enabled": True, "thinkIntervalSec": 2} for rid in ids]},
        }))
        await ws.send(json.dumps({"type": "meeting.start", "patch": {}}))
        got_event = False
        started = False
        import time as _time
        deadline = _time.monotonic() + 90  # 整体 90s deadline
        while _time.monotonic() < deadline and not got_event:
            try:
                raw = await asyncio.wait_for(ws.recv(), 2.0)
            except asyncio.TimeoutError:
                continue
            except Exception as e:
                print("ws closed:", e)
                break
            m = json.loads(raw)
            t = m.get("type")
            if t == "meeting.started":
                started = True
                print("meeting.started OK; models:", m.get("claudeModels"))
                await ws.send(json.dumps({"type": "user.speech", "text": "这个价格太贵了，能不能便宜点？我们预算有限。"}))
            elif t in ("agent.observe", "agent.reply", "agent.interrupt"):
                got_event = True
                print(f"*** {t} [{m.get('role')}] {m.get('text', '')[:80]}")
            elif t in ("asr.status", "roles.list"):
                continue
            else:
                print("->", t)
        print("RESULT:", "PASS 真实 Claude 事件已回传" if got_event else ("FAIL meeting.started=%s 但无 agent 事件" % started))
        await ws.send(json.dumps({"type": "meeting.stop"}))
        await asyncio.sleep(1)

asyncio.run(main())
