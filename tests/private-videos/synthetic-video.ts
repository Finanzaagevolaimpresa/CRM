import type { Page } from '@playwright/test';
export async function playableWebm(page: Page) {
  const base64 = await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 90;
    const context = canvas.getContext('2d')!, stream = canvas.captureStream(12);
    const mimeType = 'video/webm;codecs=vp8';
    if (!MediaRecorder.isTypeSupported(mimeType)) throw new Error('SYNTHETIC_CODEC_NOT_SUPPORTED');
    const recorder = new MediaRecorder(stream, { mimeType }), parts: Blob[] = [];
    const complete = new Promise<void>((resolve, reject) => {
      recorder.ondataavailable = event => { if (event.data.size) parts.push(event.data); };
      recorder.onstop = () => resolve(); recorder.onerror = () => reject(new Error('SYNTHETIC_CAPTURE_FAILED'));
    });
    recorder.start(50);
    for (let frame = 0; frame < 10; frame++) {
      context.fillStyle = frame % 2 ? '#247c54' : '#123047'; context.fillRect(0, 0, 160, 90);
      context.fillStyle = 'white'; context.font = '14px sans-serif'; context.fillText('Synthetic ' + frame, 15, 48);
      await new Promise(resolve => setTimeout(resolve, 90));
    }
    recorder.stop(); await complete; stream.getTracks().forEach(track => track.stop());
    const bytes = new Uint8Array(await new Blob(parts, { type: 'video/webm' }).arrayBuffer());
    return btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''));
  });
  return Buffer.from(base64, 'base64');
}
