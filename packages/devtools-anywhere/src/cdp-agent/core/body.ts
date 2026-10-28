/** Text when the content type is textual, base64 otherwise, as CDP's content results expect. */
export async function readBody(res: Response): Promise<{ body: string; base64Encoded: boolean }> {
  const type = res.headers.get('content-type') || '';
  if (/^text\/|json|javascript|xml|svg/.test(type)) return { body: await res.text(), base64Encoded: false };
  const blob = await res.blob();
  // Chrome reports an empty body as plain text, whatever its type.
  if (!blob.size) return { body: '', base64Encoded: false };
  return { body: await base64(blob), base64Encoded: true };
}

/** Base64 of binary data, encoded by the browser. */
export function base64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    // A data: URL: `data:<type>;base64,<data>`, but a bare `data:` for an empty blob.
    reader.onload = () => {
      const url = String(reader.result);
      const comma = url.indexOf(',');
      resolve(comma < 0 ? '' : url.slice(comma + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
