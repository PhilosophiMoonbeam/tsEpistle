import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { ai, ax, typesafe, type AxBox } from '@ax-llm/ax';
import { options, scriptedAI, type Example, type ExampleContext } from './support.js';

const side = 320;
const expectedBox = { top: 0.25, bottom: 0.75, left: 0.25, right: 0.75 };

// A real 320x320 still image: black square [80,240)x[80,240) on white.
// 102,400 pixels exceeds Jev's 78,400 minimum (256x256 would NOT).
function squarePng(): Buffer {
  const crc32 = (bytes: Buffer) => {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (name: string, payload: Buffer) => {
    const typeAndData = Buffer.concat([Buffer.from(name), payload]);
    const size = Buffer.alloc(4); size.writeUInt32BE(payload.length);
    const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(typeAndData));
    return Buffer.concat([size, typeAndData, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(side, 0); header.writeUInt32BE(side, 4);
  header[8] = 8; header[9] = 0; // 8-bit grayscale, no interlace.
  const rows = Buffer.alloc((side + 1) * side, 255);
  for (let y = 0; y < side; y++) {
    rows[y * (side + 1)] = 0; // PNG filter: None.
    if (y >= 80 && y < 240) rows.fill(0, y * (side + 1) + 81, y * (side + 1) + 241);
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

// Restricted baseline JPEG encoder for this block-aligned, grayscale fixture only.
// Every 8x8 block is constant: only a DC coefficient and AC end-of-block are needed.
// This is not an image preparation library; real photos need an orientation/resize pipeline.
function squareJpeg(): Buffer {
  const segment = (marker: number, data: readonly number[]) => {
    const length = data.length + 2;
    return Buffer.from([0xff, marker, length >>> 8, length & 255, ...data]);
  };
  const dcCounts = Array<number>(16).fill(0); dcCounts[3] = 12;
  const acCounts = Array<number>(16).fill(0); acCounts[0] = 1;
  const entropy: number[] = [];
  let accumulator = 0; let occupied = 0;
  const bits = (value: number, count: number) => {
    for (let bit = count - 1; bit >= 0; bit--) {
      accumulator = (accumulator << 1) | ((value >>> bit) & 1);
      occupied++;
      if (occupied === 8) {
        entropy.push(accumulator);
        if (accumulator === 255) entropy.push(0); // JPEG byte stuffing.
        accumulator = 0; occupied = 0;
      }
    }
  };
  let previousDC = 0;
  for (let y = 0; y < side; y += 8) for (let x = 0; x < side; x += 8) {
    const sample = x >= 80 && x < 240 && y >= 80 && y < 240 ? 0 : 255;
    const dc = 8 * (sample - 128);
    const difference = dc - previousDC; previousDC = dc;
    const category = difference === 0 ? 0 : Math.floor(Math.log2(Math.abs(difference))) + 1;
    bits(category, 4); // Canonical DC table: category 0..11 has a 4-bit code.
    if (category) bits(difference < 0 ? difference + (1 << category) - 1 : difference, category);
    bits(0, 1); // AC EOB.
  }
  if (occupied) bits((1 << (8 - occupied)) - 1, 8 - occupied);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    segment(0xdb, [0, ...Array<number>(64).fill(1)]),
    segment(0xc0, [8, side >>> 8, side & 255, side >>> 8, side & 255, 1, 1, 0x11, 0]),
    segment(0xc4, [0, ...dcCounts, ...Array.from({ length: 12 }, (_, index) => index), 0x10, ...acCounts, 0]),
    segment(0xda, [1, 1, 0, 0, 63, 0]), Buffer.from(entropy), Buffer.from([0xff, 0xd9]),
  ]);
}

function prepare(format: 'png' | 'jpeg') {
  const bytes = format === 'png' ? squarePng() : squareJpeg();
  // Application-owned preparation boundary. SDK validates base64/size, not orientation/resize.
  assert(side >= 256 && side <= 1568 && side * side >= 78_400);
  assert(bytes.length <= 16 * 1024 * 1024);
  return { bytes, image: { mimeType: `image/${format}`, data: bytes.toString('base64') } };
}
function decisionOptions(ctx: ExampleContext) {
  return { ...options(ctx), model: 'jev-1.14.0', modelConfig: {} };
}
function pixels(box: AxBox) {
  return { x: box.left * side, y: box.top * side, width: (box.right - box.left) * side, height: (box.bottom - box.top) * side };
}
function validateRegion(box: AxBox) {
  for (const coordinate of Object.values(box)) assert(Number.isFinite(coordinate) && coordinate >= 0 && coordinate <= 1);
  assert(box.top < box.bottom && box.left < box.right);
}
function nativeFixture(box: AxBox = expectedBox, present = true) {
  return ai({ name: 'typesafe', apiKey: 'isolated-fixture-not-a-secret', config: { model: 'jev-1.14.0' }, options: {
    fetch: async (input, init) => {
      const request = new Request(input, init);
      assert.equal(request.headers.get('TypeSafe-Danger-Zone-Images'), 'true');
      const body = await request.text();
      assert(body.includes('data_base64')); assert(body.includes('jev-1.14.0'));
      return Response.json({ model: 'jev-1.14.0', answers: { present: { type: 'noul', noul: present ? 0.98 : 0.02 }, target: { type: 'box', box, confidence: 0.91 } }, usage: { input_tokens: 45, output_tokens: 8 } });
    },
  } });
}

export const examples: readonly Example[] = [
  {
    id: '07-images/native-localization',
    title: 'Locate a square in real PNG and JPEG fixtures with native evidence',
    features: ['PNG', 'JPEG', 'experimental Jev Box', 'presence boolean', 'image preparation', 'normalized coordinates', 'native evidence'],
    modes: ['offline', 'live'],
    async run(ctx) {
      const results = [];
      for (const format of ['png', 'jpeg'] as const) {
        const prepared = prepare(format);
        const locate = ax('photo:image -> present:boolean "Is a black square visible in photo?", target:box(evidence) "The black square in photo"');
        const result = await locate.forward(ctx.mode === 'live' ? ctx.decisions : nativeFixture(), { photo: prepared.image }, decisionOptions(ctx));
        validateRegion(result.target.value);
        assert.equal(result.target.provenance.source, 'native');
        const crop = result.present ? pixels(result.target.value) : null;
        if (ctx.mode === 'offline') {
          assert.equal(result.present, true); assert.deepEqual(result.target.value, expectedBox);
          assert.equal(result.target.confidence, 0.91); assert.deepEqual(crop, { x: 80, y: 80, width: 160, height: 160 });
        }
        results.push({ format, dimensions: [side, side], decodedBytes: prepared.bytes.length, result, crop });
      }
      return {
        results, prerequisite: 'Live: Typesafe image/Box access, Jev 1.14.0 or preview. Experimental API; ctx.decisions must be Typesafe.',
        proof: 'Offline: real SDK image asset mapping/header/evidence decoding, not localization accuracy.',
        sourceConflicts: [
          'Provider summary excludes Jev media broadly; dedicated Typesafe guide narrowly permits experimental PNG/JPEG/Box, not audio/files/tools.',
          'Typesafe guide claims generated-language Box availability; signature guide says AxIR backlog. These cases establish TypeScript only, not port availability.',
        ],
      };
    },
  },
  {
    id: '07-images/native-assets',
    title: 'Reference owned native image assets using unique keys',
    features: ['native assets', 'systemOne Box', 'Noul presence', 'asset references', 'public fetch customization'],
    modes: ['offline', 'live'],
    async run(ctx) {
      const prepared = prepare('png');
      const reference = 'photo-4d1620bf-2c64-4e7a-a9c6-a5bf7db27748';
      const fixture = typesafe({ apiKey: 'isolated-fixture-not-a-secret', options: { fetch: async (input, init) => {
        const request = new Request(input, init);
        assert.equal(request.headers.get('TypeSafe-Danger-Zone-Images'), 'true');
        assert((await request.text()).includes(reference));
        return Response.json({ model: 'jev-1.14.0', answers: { present: { type: 'noul', noul: 0.99 }, target: { type: 'box', box: expectedBox, confidence: 0.93 } }, usage: { input_tokens: 30, output_tokens: 6 } });
      } } });
      const client = ctx.mode === 'live' ? ctx.nativeDecisions : fixture;
      const result = await client.systemOne({
        model: 'jev-1.14.0', state: { photo: reference, task: 'Locate the black square' },
        assets: { [reference]: { type: 'image', format: 'png', data_base64: prepared.image.data } },
        questions: { present: { type: 'noul', instructions: `Is a black square visible in ${reference}?` }, target: { type: 'box', instructions: `The black square in ${reference}` } },
      }, { abortSignal: ctx.signal });
      validateRegion(result.answers.target.box);
      const crop = result.answers.present.noul >= 0.9 ? pixels(result.answers.target.box) : null;
      if (ctx.mode === 'offline') assert.deepEqual(crop, { x: 80, y: 80, width: 160, height: 160 });
      return { result, crop, prerequisite: 'Live native Typesafe image/Box entitlement; no multipart upload or hosted URL.' };
    },
  },
  {
    id: '07-images/generative-localization',
    title: 'Use the same Box contract with generative vision, without native confidence',
    features: ['generative Box', 'elicited provenance', 'vision provider', 'validated Box'],
    modes: ['offline', 'live'],
    async run(ctx) {
      const prepared = prepare('png');
      const locate = ax('photo:image -> present:boolean "Is a black square visible?", target:box(evidence) "The black square"');
      const model = ctx.mode === 'live' ? ctx.ai : scriptedAI([{ results: [{ index: 0, content: JSON.stringify({ present: true, target: { box: expectedBox } }) }] }]);
      const result = await locate.forward(model, { photo: prepared.image }, options(ctx));
      validateRegion(result.target.value);
      assert.equal(result.target.provenance.source, 'elicited');
      assert(!('confidence' in result.target));
      return { result, crop: result.present ? pixels(result.target.value) : null, prerequisite: 'Live: generative provider/model supporting inline image input; NOT OpenAI Decisions.', proof: 'Shared shape does not imply calibrated or native localization confidence.' };
    },
  },
  {
    id: '07-images/validation-and-absence',
    title: 'Reject invalid Box boundaries and incompatible native transport; gate absent targets',
    features: ['Box validation', 'OpenAI Decisions Box rejection', 'absence gate', 'no clamping', 'preparation boundary'],
    modes: ['offline'],
    async run(ctx) {
      const prepared = prepare('png');
      const locate = ax('photo:image -> present:boolean, target:box(evidence)');
      const absent = await locate.forward(nativeFixture(expectedBox, false), { photo: prepared.image }, decisionOptions(ctx));
      const consumed = absent.present ? pixels(absent.target.value) : null;
      assert.equal(consumed, null); // A Box is always returned, including when absent.
      const invalidBoxes = [
        { ...expectedBox, top: -0.1 }, { ...expectedBox, top: 0.75 },
        { ...expectedBox, left: 0.9 }, { ...expectedBox, right: Number.POSITIVE_INFINITY },
      ];
      for (const box of invalidBoxes) {
        await assert.rejects(() => locate.forward(nativeFixture(box), { photo: prepared.image }, { ...decisionOptions(ctx), maxRetries: 0 }), /box|coordinate|finite|top|left/i);
      }
      let transportCalls = 0;
      const incompatible = ai({ name: 'openai-decisions', apiKey: 'isolated-fixture-not-a-secret', options: { fetch: async () => { transportCalls++; throw new Error('Unexpected network call'); } } });
      await assert.rejects(() => locate.forward(incompatible, { photo: prepared.image }, { ...options(ctx), modelConfig: {}, maxRetries: 0 }), /box/i);
      assert.equal(transportCalls, 0);
      await assert.rejects(() => locate.forward(nativeFixture(), { photo: { mimeType: 'image/png', data: 'https://example.invalid/photo.png' } }, { ...decisionOptions(ctx), maxRetries: 0 }), /base64|image|url/i);
      return { absent: { present: absent.present, regionStillReturned: absent.target.value, consumed }, invalidBoxesRejected: invalidBoxes.length, openaiDecisionTransportCalls: transportCalls, preparation: 'Orient/resize real photos before forward; Ax does not resize or clamp. Each side 256–1568; area >=78400; <=16MiB/image, <=32MiB/request.' };
    },
  },
];
