# Project banners

TMatrix advertises `capabilities: ["project_banner"]` in poll requests. Tzu Do
can use that capability to send banner jobs only to engines that can upload
their image output. Older task and journal tickets keep their existing contract.

A banner ticket has `subject_kind: "project_banner"` and a canonical
`project_id`. It has no `task_id`. Its claim, history, progress, and result
callbacks use `/api/v1/ai/project-banner-tickets/{ticket_id}/` on the configured
poll origin.

The runtime receives an isolated working directory and a banner-specific output
schema. Its handoff includes `banner_image_path` alongside `outcome`,
`context_summary`, and `user_message`. After image generation, the runtime copies
the output into that working directory and returns the copied file's absolute
path. If generation cannot finish, it returns `AI_NEEDS_FEEDBACK` with a null
image path.

The engine accepts only regular PNG, JPEG, or WebP files inside that claim's
directory, up to 10 MiB. It sends the bytes to
`POST /api/uploads/images/upload` in the multipart `image` field. The engine
attaches the configured Tzu Do API key itself. The runtime never receives that
key. The result callback includes the returned relative `banner_image_url` so
Tzu Do can apply it to the project.

An atomic local checkpoint saves the upload URL and finished handoff before
result delivery. An outage retries the same result, and a recovered claim reuses
the checkpoint without generating or uploading another image. A crash during an
ambiguous upload can leave an unused uploaded image because the upload endpoint
does not provide an idempotency key. After Tzu Do accepts the result and the
runtime closes, the engine removes the temporary image and checkpoint.

Banner generation requires an updated TMatrix engine and an image-generation
tool available to the runtime's selected model and signed-in account. The pinned
Codex 0.158.0 runtime reports image generation as a stable enabled feature.
Capability advertisement identifies support for this transport contract, rather
than guaranteeing that a particular account can generate an image.

`npm run check` includes file-to-multipart-to-result tests with a PNG fixture,
recovery after a failed callback, unavailable generation, and invalid artifact
rejection. Those tests use a runtime fixture and do not call a live image model.
