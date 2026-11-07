import assert from 'node:assert/strict';
import { ax, f, s, type AxChatResponse, type AxGenInput } from '@ax-llm/ax';
import { z } from 'zod';
import { options, scriptedAI, type Example } from './support.js';

// These are deterministic model-output fixtures, not evidence of model quality.
const json = (value: unknown): AxChatResponse => ({
  results: [{ index: 0, content: JSON.stringify(value), finishReason: 'stop' }],
});

export const examples: readonly Example[] = [
  {
    id: '01-signatures/string-contract',
    title: 'Reusable strings: constrained invoice extraction and lossless serialization',
    features: ['s', 'modifiers', 'nested objects', 'arrays', 'optional', 'value descriptions', 'round-trip'],
    modes: ['offline', 'live'],
    async run(ctx) {
      // Strings own shape/constraints; outcome descriptions guide, rather than validate, decisions.
      const signature = s(`"Extract invoice facts" invoiceText:string(cache) ->
        invoiceNumber:string(pattern "^INV-[0-9]+$" "INV- then digits"),
        totalAmount:number(min 0, max 10000),
        lineItems:object{ productName:string(min 1), quantity:number(min 1), note?:string }[],
        tags:string(item "one category")[],
        approved:boolean(true "Total is within policy", false "Needs review"),
        department:class "billing, support"(billing "Invoice questions", support "Usage help")`);
      const serialized = signature.toString();
      assert.equal(s(serialized).toString(), serialized);
      const gen = ax(signature);
      const ai = ctx.mode === 'live' ? ctx.ai : scriptedAI([json({
        invoiceNumber: 'INV-42', totalAmount: 24,
        lineItems: [{ productName: 'Notebook', quantity: 2 }], tags: ['stationery'],
        approved: true, department: 'billing',
      })], { structuredOutputs: true });
      const result = await gen.forward(ai, {
        invoiceText: 'INV-42: two Notebook items at $12 each, total $24. Policy permits totals below $100. Department billing. Category stationery.',
      }, options(ctx));
      assert.equal(result.invoiceNumber, 'INV-42');
      assert.equal(result.totalAmount, 24);
      assert.equal(result.lineItems[0]?.quantity, 2);
      return { result, roundTrip: true, proof: 'shape and facts on this input; descriptions are not extra constraints' };
    },
  },
  {
    id: '01-signatures/fluent-hybrid',
    title: 'Fluent nested profile plus a hybrid signature extension',
    features: ['f', 'hybrid', 'nested arrays', 'internal', 'cache', 'code', 'json'],
    modes: ['offline'],
    async run(ctx) {
      // Fluent builders are useful when reusable field contracts come from application code.
      const profile = f.object({
        displayName: f.string().min(3).max(30),
        contactEmail: f.email(),
        websiteUrl: f.url().optional(),
        ageYears: f.number().min(18).max(120),
        skills: f.string().min(2).array(),
        education: f.object({ schoolName: f.string(), degreeName: f.string().optional() }).array(),
      });
      const signature = f().description('Normalize a member profile')
        .input('profileNotes', f.string().cache())
        .input('previousTags', f.string().array().optional())
        .output('scratchpad', f.string().internal())
        .output('memberProfile', profile).build();
      const result = await ax(signature).forward(scriptedAI([json({
        scratchpad: 'Normalize the supplied facts',
        memberProfile: { displayName: 'Ada', contactEmail: 'ada@example.com', ageYears: 36,
          skills: ['math'], education: [{ schoolName: 'Home study' }] },
      })], { structuredOutputs: true }), { profileNotes: 'Ada, 36, ada@example.com; math; Home study' }, options(ctx));
      assert.equal(result.memberProfile.contactEmail, 'ada@example.com');
      assert.equal('scratchpad' in result, false);
      const hybrid = s('taskBrief:string -> pythonCode:code(python)')
        .appendInputField('metadata', f.json().optional())
        .appendOutputField('qualityScore', f.number().min(0).max(1));
      const generated = await ax(hybrid).forward(scriptedAI([{
        results: [{ index: 0, content: 'Python Code: ```python\nprint(2 + 2)\n```\nQuality Score: 1', finishReason: 'stop' }],
      }]), { taskBrief: 'Print 2+2', metadata: { audience: 'beginner' } }, options(ctx));
      assert.equal(generated.pythonCode.trim(), 'print(2 + 2)');
      assert.equal(generated.qualityScore, 1);
      return { profile: result.memberProfile, generated, internalRemoved: true };
    },
  },
  {
    id: '01-signatures/standard-schema',
    title: 'Standard Schema fields execute transformations and custom refinements',
    features: ['StandardSchema', 'zod', 'per-field schema', 'whole-object schema', 'transform', 'refine', 'superRefine'],
    modes: ['offline'],
    async run(ctx) {
      // Zod owns application-specific semantics that modifier bags cannot express.
      const signature = f()
        .input(z.object({ policyText: z.string(), customerNote: z.string().min(1) }),
          { fields: { policyText: { cache: true } } })
        .output('scratchpad', z.string(), { internal: true })
        .output('contactEmail', z.string().email().transform((value) => value.toLowerCase()))
        .output('accountCode', z.string().refine((value) => value.startsWith('AC-'), 'Use an AC- account code'))
        .build();
      const gen = ax(signature);
      const result = await gen.forward(scriptedAI([
        { results: [{ index: 0, content: 'Scratchpad: Normalize\nContact Email: ADA@EXAMPLE.COM\nAccount Code: bad', finishReason: 'stop' }] },
        { results: [{ index: 0, content: 'Scratchpad: Correct code\nContact Email: ADA@EXAMPLE.COM\nAccount Code: AC-42', finishReason: 'stop' }] },
      ]), { policyText: 'Codes start AC-', customerNote: 'ADA@EXAMPLE.COM, account AC-42' }, options(ctx));
      assert.equal(result.contactEmail, 'ada@example.com');
      assert.equal(result.accountCode, 'AC-42');
      assert.equal('scratchpad' in result, false);
      assert.equal(gen.getChatLog().length, 2);
      // 25.4.9 reads enum def.values, but Zod 4 stores def.entries.
      // Keep the rejected boundary visible; do not claim enum conversion worked.
      assert.throws(() => f().input('requestText', z.string())
        .output(z.object({ priority: z.enum(['low', 'high']) })).build(), /Class type requires options/);
      // Supported Standard Schema shape: a string with runtime membership validation.
      const whole = f().input('requestText', z.string())
        .output(z.object({
          priority: z.string().refine((value) => value === 'low' || value === 'high', 'Use low or high'),
          summary: z.string().superRefine((value, context) => {
            if (!value.includes('invoice')) context.addIssue({ code: 'custom', message: 'Mention invoice' });
          }),
        })).build();
      const wholeGen = ax(whole);
      const triage = await wholeGen.forward(scriptedAI([
        { results: [{ index: 0, content: 'Priority: urgent\nSummary: Review the dispute', finishReason: 'stop' }] },
        { results: [{ index: 0, content: 'Priority: high\nSummary: Review the invoice', finishReason: 'stop' }] },
      ]), { requestText: 'Urgent invoice dispute' }, options(ctx));
      assert.equal(triage.priority, 'high');
      assert.match(triage.summary, /invoice/);
      assert.equal(wholeGen.getChatLog().length, 2);
      // Native Ax class fields retain actual enum options in the prompt and parser.
      const classified = await ax(f().input('requestText', f.string())
        .output('priority', f.class(['low', 'high'] as const)).build()).forward(scriptedAI([{
          results: [{ index: 0, content: 'Priority: high', finishReason: 'stop' }],
        }]), { requestText: 'Urgent invoice dispute' }, options(ctx));
      assert.equal(classified.priority, 'high');
      return { result, triage, classified, zod4EnumConversionRejected: true, correctionRequests: gen.getChatLog().length,
        proof: 'Schema validation and native class parsing execute; Zod 4 enum conversion is a pinned SDK defect, not supported by this example' };
    },
  },
  {
    id: '01-signatures/date-boundaries',
    title: 'Dates and ranges: ISO instants, literal zones and rejected boundaries',
    features: ['date', 'datetime', 'dateRange', 'datetimeRange', 'validation failures'],
    modes: ['offline'],
    async run(ctx) {
      const gen = ax('bookingNote:string -> birthDate:date, startsAt:datetime, stayWindow:dateRange, meetingWindow:datetimeRange');
      const result = await gen.forward(scriptedAI([{ results: [{ index: 0, content:
        'Birth Date: 1990-05-09\nStarts At: 2024-07-01 10:00 PST\nStay Window: 2024-07-01/2024-07-03\nMeeting Window: ["2024-07-01T18:00:00Z", "2024-07-01T19:00:00Z"]', finishReason: 'stop' }] }]),
        { bookingNote: 'Born May 9 1990; July 1 at 10 PST; stay July 1-3; meeting 18-19 UTC' }, options(ctx));
      assert(result.birthDate instanceof Date);
      assert.equal(result.startsAt.toISOString(), '2024-07-01T18:00:00.000Z');
      assert(result.stayWindow.start < result.stayWindow.end);
      assert.equal(result.meetingWindow.end.toISOString(), '2024-07-01T19:00:00.000Z');
      const rejected: string[] = [];
      for (const [type, value] of [
        ['date', '2024-02-30'], ['datetime', '2024-07-01 10:00 IST'],
        ['datetime', '2024-03-10 02:30 America/New_York'], ['dateRange', '2024-07-03/2024-07-01'],
      ] as const) {
        const invalid = ax(s(`bookingNote:string -> parsedDate:${type}`));
        await assert.rejects(() => invalid.forward(scriptedAI([{ results: [{ index: 0,
          content: `Parsed Date: ${value}`, finishReason: 'stop' }] }]),
          { bookingNote: value }, { ...options(ctx), maxRetries: 0 }), /validation|date|range|timezone|invalid/i);
        rejected.push(value);
      }
      return { result, rejected, proof: 'Parsing and boundary validation, not calendar interpretation quality' };
    },
  },
  {
    id: '01-signatures/media-shape',
    title: 'Top-level media metadata reaches the chat request without network I/O',
    features: ['image', 'audio', 'file', 'url', 'media metadata', 'input arrays'],
    modes: ['offline'],
    async run(ctx) {
      // Tiny owned fixtures test forwarding only, not decoding, vision or speech quality.
      const signature = f().input('productPhotos', f.image().array())
        .input('meetingAudio', f.audio()).input('priceSheet', f.file())
        .input('sourceUrl', f.url()).output('summaryText', f.string()).build();
      // The chat-part metadata is wider than AxAudioInput in this release.
      const meetingAudio = { data: 'YXVkaW8=', format: 'wav' as const, mimeType: 'audio/wav',
        sampleRate: 16000, channels: 1, transcription: 'fixture speech', duration: 1 };
      const input: AxGenInput<typeof signature> = {
        productPhotos: [{ mimeType: 'image/png', data: 'aW1hZ2U=', details: 'low', altText: 'fixture swatch', optimize: 'size', cache: true }],
        meetingAudio,
        priceSheet: { mimeType: 'text/plain', data: 'UHJpY2U6IDI0', filename: 'price.txt', extractedText: 'Price: 24', cache: true },
        sourceUrl: 'https://example.com/catalog',
      };
      let captured = '';
      const result = await ax(signature).forward(scriptedAI((request) => {
        captured = JSON.stringify(request.chatPrompt);
        return { results: [{ index: 0, content: 'Summary Text: Fixture assets received', finishReason: 'stop' }] };
      }, { media: {
        images: { supported: true, formats: ['image/png'] },
        audio: { supported: true, formats: ['wav'] },
        files: { supported: true, formats: ['text/plain'], uploadMethod: 'inline' },
        urls: { supported: true, webSearch: false, contextFetching: false },
      } }), input, options(ctx));
      for (const marker of ['fixture swatch', 'price.txt', 'fixture speech', '16000']) assert(captured.includes(marker));
      return { result, forwardedMetadata: ['image details/altText', 'file filename/extractedText', 'audio transcription/sampleRate'], proof: 'request mapping only; fixture bytes are not valid media' };
    },
  },
  {
    id: '01-signatures/box-boundaries',
    title: 'Normalized boxes are geometry, not target presence or native confidence',
    features: ['box', 'box evidence', 'nested boxes', 'optional boxes', 'box arrays', 'geometry validation'],
    modes: ['offline'],
    async run(ctx) {
      const signature = f().input('sceneDescription', f.string())
        .output('targetPresent', f.boolean())
        .output('targetRegion', f.box().withEvidence())
        .output('otherRegions', f.box().array())
        .output('annotation', f.object({ cropRegion: f.box().optional() })).build();
      const box = { top: 0.1, bottom: 0.6, left: 0.2, right: 0.8 };
      const result = await ax(signature).forward(scriptedAI([json({ targetPresent: true,
        targetRegion: { box }, otherRegions: [box], annotation: { cropRegion: box } })], { structuredOutputs: true }),
        { sceneDescription: 'A target occupies x=20..80, y=10..60 in a 100x100 image' }, options(ctx));
      assert.equal(result.targetPresent, true);
      assert.deepEqual(result.targetRegion.value, box);
      assert.equal(result.targetRegion.confidence, undefined);
      assert.equal(result.targetRegion.provenance.source, 'elicited');
      for (const invalid of [{ ...box, left: 0.9 }, { ...box, top: 0.6 }, { ...box, right: 1.1 }]) {
        await assert.rejects(() => ax('sceneDescription:string -> targetRegion:box').forward(
          scriptedAI([json({ targetRegion: invalid })], { structuredOutputs: true }),
          { sceneDescription: 'Invalid geometry fixture' }, { ...options(ctx), maxRetries: 0 }), /box|validation|coordinate|left|top|right/i);
      }
      return { result, pixels: { x: box.left * 100, y: box.top * 100, width: (box.right - box.left) * 100 }, proof: 'geometry only; no image localization was performed' };
    },
  },
  {
    id: '01-signatures/invalid-contracts',
    title: 'Reject invalid signatures before a provider call',
    features: ['strict string grammar', 'media restrictions', 'field ownership'],
    modes: ['offline'],
    async run() {
      const invalid = [
        'requestText:string -> urgent:boolean(min 1)',
        'requestText:string -> generatedImage:image',
        'requestText:string -> generatedFiles:file[]',
        'requestText:string -> generatedSpeech:audio[]',
        'requestText:string -> profile:object{ avatar:image }',
        'requestText:string -> profile:object{ note!:string }',
        'requestText:string -> profile:object{ note:string(cache) }',
        'requestText:string -> team:class "billing, support"(missing "Unknown label")',
      ];
      for (const contract of invalid) assert.throws(() => s(contract));
      const description = 'Keep "quotes" and \\ paths';
      const sig = f().description(description).input('requestText', f.string()).output('answerText', f.string()).build();
      assert.equal(s(sig.toString()).getDescription(), description);
      return { rejectedContracts: invalid.length, descriptionRoundTrip: true };
    },
  },
];
