/** TTS 模块与 store 的最小耦合接口（避免循环依赖） */
export interface MeetingStoreLike {
  onTtsStart: (windowId: string) => void
  onTtsEnd: (windowId: string) => void
  onTtsError: (msg: string) => void
}
