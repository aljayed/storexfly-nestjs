export const FACE_MESSAGES = {
  expired: 'The camera check was interrupted or expired. Please start again.',
  no_face: 'Look at the camera in good light so we can see your whole face.',
  multiple_faces: 'Only you should be in the frame.',
  quality:
    'Move closer and use even lighting. Keep your face clear and steady.',
  too_far: 'Move closer so your face fills the oval.',
  too_close: 'Move back a little so your whole face fits in the oval.',
  off_frame: 'Bring your face into the middle of the oval.',
  too_dark: 'It is too dark. Face a window or a lamp.',
  too_bright:
    'Too much light on your face. Step out of direct light or sunlight.',
  blurry: 'The picture is blurry. Hold your phone still.',
  pose: 'Follow the head-turn prompt, then look straight again.',
  mismatch: 'We could not confirm the same face throughout. Please try again.',
  replay: 'We could not confirm a fresh camera capture. Please try again.',
  spoof:
    'We could not confirm a live face. Use your camera directly in good light.',
  duplicate:
    'This face is already registered on another Hoomri account, and each person gets one free shop. Sign in to that account to open or run your shop. If it is not yours, contact Hoomri support.',
  review:
    'This face is close to one on another account, so a person from our team will take a look - usually within a day. We will let you open your shop as soon as it is cleared.',
} as const;

export type FaceFailure = keyof typeof FACE_MESSAGES;

/**
 * Problems with a single frame, not with the attempt: the step's hold starts
 * over and the person is told what to fix, live, while the session goes on.
 */
export const SOFT_FAILURES: ReadonlySet<FaceFailure> = new Set<FaceFailure>([
  'no_face',
  'multiple_faces',
  'quality',
  'too_far',
  'too_close',
  'off_frame',
  'too_dark',
  'too_bright',
  'blurry',
]);
export type FaceResult =
  | { status: 'verified'; verifiedAt: string }
  | { status: 'failed'; reason: FaceFailure; message: string };

export class FaceCheckFailed extends Error {
  constructor(readonly reason: FaceFailure) {
    super(reason);
  }
}

export const failedResult = (reason: FaceFailure): FaceResult => ({
  status: 'failed',
  reason,
  message: FACE_MESSAGES[reason],
});
