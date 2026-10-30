/**
 * 两端共用的语音面板：只嵌入统一语音服务，不创建第二个 Pet 或窗口。
 * 关闭时卸载 iframe，实时会话随页面退出释放。
 * @module dsh-pet/src/shared/voice-panel
 */
export async function mountVoicePanel(petId: string, base: string): Promise<void> {
  const old = document.getElementById('dsh-pet-voice-panel');
  old?.remove();
  const response = await fetch(base + '/voice-panel?pet=' + encodeURIComponent(petId), { method: 'POST' });
  const result: unknown = await response.json();
  if (!result || typeof result !== 'object' || !('url' in result) || typeof result.url !== 'string')
    throw new Error('统一语音插件尚未就绪');
  const url = new URL(result.url);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') throw new Error('语音地址必须来自本机');
  const root = document.createElement('div');
  root.id = 'dsh-pet-voice-panel';
  root.dataset.petId = petId;
  root.style.cssText =
    'position:fixed;right:8px;top:8px;width:min(390px,calc(100vw - 16px));height:min(540px,calc(100vh - 16px));z-index:2147483005;background:#f5f7fa;border-radius:16px;box-shadow:0 8px 35px #0004;overflow:hidden';
  const close = document.createElement('button');
  close.textContent = '×';
  close.title = '关闭语音面板';
  close.style.cssText =
    'position:absolute;right:8px;top:5px;z-index:2;border:0;background:transparent;font-size:24px;cursor:pointer';
  close.onclick = () => root.remove();
  const frame = document.createElement('iframe');
  frame.src = url.href;
  frame.allow = 'microphone; autoplay';
  frame.title = 'Pet 语音';
  frame.style.cssText = 'width:100%;height:100%;border:0';
  root.append(frame, close);
  document.body.append(root);
}

/**
 * 现有 Pet 的无麦克风后台播放器。面板打开时让出声音，卸载时释放 iframe。
 * @param petId - 当前 Pet。
 * @param base - 现有桌宠桥地址。
 * @returns 卸载清理函数。
 */
export function mountVoiceAgent(petId: string, base: string): () => void {
  let disposed = false;
  let frame: HTMLIFrameElement | undefined;
  let timer: ReturnType<typeof setTimeout>;
  const mount = async (): Promise<void> => {
    try {
      const response = await fetch(base + '/voice-panel?pet=' + encodeURIComponent(petId), { method: 'POST' });
      const value: unknown = await response.json();
      if (disposed) return;
      if (!response.ok || !value || typeof value !== 'object' || !('url' in value) || typeof value.url !== 'string')
        throw new Error('voice unavailable');
      const url = new URL(value.url);
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') throw new Error('invalid voice origin');
      url.searchParams.set('background', '1');
      frame?.remove();
      frame = document.createElement('iframe');
      frame.hidden = true;
      frame.allow = 'autoplay';
      frame.title = 'Pet 后台语音（不启用麦克风）';
      frame.src = url.href;
      document.body.append(frame);
      timer = setTimeout(() => {
        void mount();
      }, 30 * 60000);
    } catch {
      if (!disposed)
        timer = setTimeout(() => {
          void mount();
        }, 30000);
    }
  };
  void mount();
  return () => {
    disposed = true;
    clearTimeout(timer);
    frame?.remove();
  };
}
