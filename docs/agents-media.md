# Images, files, and speech in Wiki Agent

Google Gemini profiles can enable these features independently in **Administration → Agents → Providers → Edit → Model roles → Images, files & voice**:

- **PDF and image attachments** lets the Agent read PDFs, PNGs, JPEGs, and WebP images through Google's Files API.
- **Image creation and editing** uses `gemini-3.1-flash-image`. It includes image uploads for editing, even when general document attachments are off.
- **Speech input** uses `gemini-3.5-transcribe`. Dictation places editable text in the composer; it never sends a message automatically.

The profile must use the Gemini Interactions protocol, the official `https://generativelanguage.googleapis.com/v1beta` endpoint, and a Google API credential. Saving a profile follows the existing connection-check and enablement workflow. The connection check verifies the main Agent model; access to the dedicated image and transcription models also depends on the Google project. No new capability is enabled by default, and unavailable capabilities have no composer controls or callable image tool.

PDFs are prepared by the TypeScript worker with qpdf 11.9 or newer available on the Wiki server's `PATH`. The standard runtime image includes qpdf; custom deployments must install it for the application process. Prepared page parts are a regenerable private cache; original attachments remain unchanged.

Enter separate input and output prices for the image and speech model roles, in **microdollars per million tokens**. For example, `1000000` means $1 per million tokens. Use the highest applicable modality rate when a model has different text and media rates. Media calls use the existing user/run token and cost limits, and failed dispatched requests retain conservative accounting when Google has not returned usable usage. File uploads and token counting happen before paid inference; failures at that stage do not incur an inference charge. The relevant model must support Google's token-count endpoint; unsupported counting fails before paid inference.

In chat, use **Attach** to choose files, or paste/drop supported files into the composer. Closing the asset picker or selecting an asset returns keyboard focus to **Attach** when it remains available. Open **Create** and explicitly select the available image, video, or music tools for the next request. Creation starts with no tools selected; a capability refresh preserves available choices, removes revoked choices, and never selects newly available tools automatically. Generated images appear in the conversation with download and **Edit image** controls. Editing explicitly selects image generation and makes a new attachment and draft, leaving the original image intact. Image mode accepts images, while ordinary chat accepts images and PDFs when configured.

**Dictate** requests microphone access only when the circular microphone button beside Send is clicked. Tap it again to stop, transcribe, and insert the transcript for review, or press Send while recording to stop, transcribe, and send the transcript together with any typed text in one message. Cancel discards only the recording; the typed draft is kept. Recording stops automatically after the speech-based countdown, or after 60 seconds from capture start when analysis is unavailable; it inserts the transcript for review without sending. The microphone is released on cancellation, navigation, a profile change, or loss of connection. Review the transcript before sending.

If transcription fails while you are editing, the newer typed draft remains intact; failure does not restore an earlier text snapshot or submit a message.

Dictation requests the browser's built-in noise suppression, echo cancellation, automatic gain control, and a mono microphone track where available. These are preferences: browsers may ignore or implement them differently. The recorded stream and live speech meter use the same captured audio; no additional denoising service receives microphone data. Background sounds can still trigger speech detection, so review the transcript. If audio analysis is unavailable, automatic silence detection is disabled; stop manually or let the recording end 60 seconds after capture starts. With analysis available, the 60-second countdown begins at detected speech, with up to 10 seconds of pre-roll.

The recording waveform exaggerates quieter changes in height so syllables remain visible; it is visual feedback, not a calibrated amplitude meter. Its neutral/green/yellow/red colors reflect unadjusted captured-signal levels and dBFS thresholds. Reduced-motion preference shows static neutral bars.

## Storage and limits

Attachments are private to their owner and conversation; they do not become public Wiki assets. Downloads require the authenticated owner. The limits are four files per message, 10 MiB per file, and 100 MiB / 200 media items per owner. Server-side byte and token limits also apply to recordings; the 60-second recording limit is a browser control.

Unsent uploads expire after one hour. Sent attachments and generated images follow conversation retention and deletion. Recordings are deleted when their transcription run ends; their transcripts remain in private run storage until conversation deletion. Large histories include only the most recent 16 media items within 40 MiB, with an explicit context note when older files are omitted.

Google files are uploaded when a run uses them, with deletion attempted after success, failure, or cancellation. Google also expires Files API uploads after 48 hours. Google file URLs and API credentials are never sent to the browser. Interactions use `store: false`; this setting does not replace the provider's broader data-use terms.

Provider references: [Files API](https://ai.google.dev/gemini-api/docs/files), [image generation](https://ai.google.dev/gemini-api/docs/image-generation), [transcription](https://ai.google.dev/gemini-api/docs/transcribe), and [token counting](https://ai.google.dev/gemini-api/docs/tokens).
