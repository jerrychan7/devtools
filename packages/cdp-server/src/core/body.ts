/** Text when the content type is textual, base64 otherwise, as CDP's content results expect. */
export async function readBody(res: Response): Promise<{ body: string; base64Encoded: boolean }> {
  const type = res.headers.get('content-type') || '';
  if (/^text\/|json|javascript|xml|svg/.test(type)) return { body: await res.text(), base64Encoded: false };
  return { body: await base64(await res.blob()), base64Encoded: true };
}

/** Base64 of binary data, encoded by the browser. */
export function base64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    // A data: URL: `data:<type>;base64,<data>`.
    reader.onload = () => resolve(String(reader.result).slice(String(reader.result).indexOf(',') + 1));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
