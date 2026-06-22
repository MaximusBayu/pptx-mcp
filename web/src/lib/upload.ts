export type UploadProgress = { stage: "uploading" | "analyzing"; pct: number };

// Uploads a template via XHR so the caller gets a real byte-level progress bar
// (fetch has no upload-progress events). Resolves with the new template id.
export function uploadTemplate(
  file: File,
  onProgress: (p: UploadProgress) => void,
): Promise<{ id: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/templates");
    xhr.upload.onprogress = (e: ProgressEvent) => {
      if (e.lengthComputable) {
        onProgress({ stage: "uploading", pct: Math.round((e.loaded / e.total) * 100) });
      }
    };
    xhr.upload.onload = () => onProgress({ stage: "analyzing", pct: 100 });
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try { resolve(JSON.parse(xhr.responseText)); }
        catch { reject(new Error("bad server response")); }
      } else {
        let msg = "upload failed";
        try { msg = JSON.parse(xhr.responseText).error ?? msg; } catch { /* keep default */ }
        reject(new Error(msg));
      }
    };
    xhr.onerror = () => reject(new Error("network error"));
    const fd = new FormData();
    fd.append("file", file);
    xhr.send(fd);
  });
}
