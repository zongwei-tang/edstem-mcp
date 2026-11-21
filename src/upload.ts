import { realpath, stat } from "node:fs/promises";
import { sep } from "node:path";

/**
 * Resolve a local path for upload_file, allowing only regular files inside `uploadDir`.
 *
 * Thread content is untrusted: injected text could ask the model to upload a private
 * file and post the link. Confining reads to one opt-in directory (ED_UPLOAD_DIR)
 * bounds that. Both sides are realpath'd so symlinks and ".." cannot escape.
 */
export async function resolveUploadPath(
  path: string,
  uploadDir: string | undefined,
  maxBytes: number
): Promise<string> {
  if (!uploadDir) {
    throw new Error(
      "Local file uploads are disabled. Set ED_UPLOAD_DIR to a directory to allow them, or use content_base64."
    );
  }
  const root = await realpath(uploadDir);
  const real = await realpath(path);
  if (real !== root && !real.startsWith(root + sep)) {
    throw new Error(`Path is outside ED_UPLOAD_DIR (${root})`);
  }
  const info = await stat(real);
  if (!info.isFile()) throw new Error(`Not a regular file: ${path}`);
  if (info.size > maxBytes) throw new Error(`File too large (${info.size} bytes, max ${maxBytes})`);
  return real;
}
