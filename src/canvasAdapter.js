/**
 * Pure @napi-rs/canvas Adapter for FestFlow
 * Uses pre-compiled native binaries across Windows, Linux, and macOS
 * without requiring legacy Cairo/Pango/Python build tools.
 */
import { createCanvas, loadImage, Image } from '@napi-rs/canvas';

export { createCanvas, loadImage, Image };
export default { createCanvas, loadImage, Image };
