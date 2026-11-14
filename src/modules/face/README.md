# Face check

One free shop per person. An account passes this once, before it opens its
shop; `ShopsService.prepareShop` refuses without `users.face_verified_at`.

Ported from Somporko's face enrollment (protocol v2) and cut down to what
Hoomri needs. Self-hosted: YuNet (detection), SFace (128-d embedding) and
MiniFASNetV2 (passive anti-spoof) as ONNX models, run in-process. No
third-party service sees a face and there is no per-check fee.

## What happens

1. `POST /face/session` starts a session and returns the current prompt and a
   one-use nonce - never the steps still to come.
2. The browser posts one JPEG at a time to `POST /face/frame` with the session
   id and nonce, waiting for each reply. Only the server measures anything; a
   pose or liveness claim from the client is not accepted.
3. Each frame must show one face, big enough, in frame, lit and sharp. On a
   frontal frame the anti-spoof model must say "live", and every frame must
   stay the same person as the first. A bad-quality frame restarts the hold
   with guidance; a not-live or different-face frame is a strike (three in a
   row or six in all end the attempt); a repeated frame ends it at once.
4. Four steps - straight, a turn (side picked at random only after step one
   passes), the opposite turn, straight again - each held for a random
   650-1050 ms over at least three frames, by server arrival time.
5. Up to five frontal samples and their mean are compared with every stored
   mean and sample on other accounts (exact scan, highest cosine wins), in one
   transaction behind one advisory lock:

   | highest similarity          | outcome                                   |
   | --------------------------- | ----------------------------------------- |
   | below `FACE_REVIEW_MIN`     | registered; the account is verified       |
   | up to `FACE_DUPLICATE_MIN`  | held - an operator must release it        |
   | `FACE_DUPLICATE_MIN` and up | refused: already on another account       |

Limits: frames at least 200 ms apart, gaps under 8 s, 25 s per step, 180
frames and 3 minutes per session, 8 sessions an hour per account.

## What is stored

Vectors and scores. **No image, ever** - frames are decoded in memory and
dropped. Vectors are rotated by a secret orthogonal matrix derived from
`FACE_TEMPLATE_KEY` before they are stored: similarity between stored faces is
preserved (so the search works) but a leaked row cannot be matched against a
stock model. This is not encryption.

`FACE_TEMPLATE_KEY` must stay the same forever and be backed up apart from the
database. `face_system` records a fingerprint of key + model on first use; if
either later differs the check turns itself off (503) instead of comparing
faces that are no longer comparable and waving duplicates through.

Deleting an account deletes its face (FK cascade), which frees that face.

## Differences from Somporko

- Sessions live in process memory, not Redis. The API is a single instance;
  a restart mid-check costs the person a retry. **Moving to several API
  instances needs a shared session store first.**
- `real[]` columns and an in-process scan, not pgvector - Hoomri's Postgres
  has no extension, and the search was always exact.
- No stored frames, no template refresh, no relation history.
- Lowest-score audit also records a struck frame's same-face score.

## Operator

Platform console → Face checks (`/platform/face-checks`): every duplicate and
near match, with the two accounts involved.

- **Release** lifts a hold so the account can try again. It is judged afresh
  and held again if it still matches.
- **Reset face** forgets an account's face, freeing it. Refused while the
  account owns a shop.

There is no "approve": with no photo kept, nobody at a console can see whether
two accounts are one person, and a score cannot settle it.

## Honest limits

- The thresholds (liveness 0.5, same-face 0.45, review 0.45, duplicate 0.55)
  are Somporko's starting points, not measured operating points. They are
  cosine similarities, not percentages.
- A browser cannot attest that pixels came from a camera. A capable virtual
  camera or responsive deepfake can pass. This raises the cost of a second
  shop; it does not prove identity.
- Twins and close lookalikes can be refused or held. Different-looking photos
  of one person years apart can be missed.
- Accounts that owned a shop before this existed were not asked for a face.

## Setup

```sh
npm run face:models          # weights into ./models, SHA-256 checked
openssl rand -hex 32         # -> FACE_TEMPLATE_KEY
```

`FACE_DEV_BYPASS=true` (ignored in production) lets a machine without a
camera skip the check. Tests: `npx jest src/modules/face`.
