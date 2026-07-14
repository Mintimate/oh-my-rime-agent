import { normalizePastedImages } from '../agents/chat/index';
import { executeRimeOpenAITool } from '../agents/chat/_tools';

const smallImage = normalizePastedImages([
  {
    name: 'tiny.png',
    type: 'image/png',
    size: 999_999,
    dataUrl: 'data:image/png;base64,AA==',
  },
]);
assert(smallImage.length === 1, 'a valid image data URL should be accepted');
assert(smallImage[0]?.size === 1, 'the server must use measured Base64 bytes instead of client size');

const oversizedBase64 = 'A'.repeat(Math.ceil(((2 * 1024 * 1024 + 1) * 4) / 3 / 4) * 4);
const oversizedImage = normalizePastedImages([
  {
    type: 'image/png',
    size: 1,
    dataUrl: `data:image/png;base64,${oversizedBase64}`,
  },
]);
assert(oversizedImage.length === 0, 'a forged client size must not bypass the server image limit');

const validPatch = await executeRimeOpenAITool(
  'make_patch',
  { entries: [{ path: 'style/candidate_list_layout', value: 'linear' }] },
  { env: {} },
);
assert(validPatch.includes('"style/candidate_list_layout": linear'), 'a valid patch path should be rendered');

const invalidPatch = await executeRimeOpenAITool(
  'make_patch',
  { entries: [{ path: 'style/name\nmalicious: true', value: 'linear' }] },
  { env: {} },
);
assert(invalidPatch === 'No valid patch entries were supplied.', 'control characters in patch paths must be rejected');

console.log('Security smoke passed.');

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message);
}
