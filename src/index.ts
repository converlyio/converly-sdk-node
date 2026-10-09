/**
 * `@converly/sdk-node` — server-side SDK for the Converly SaaS-signup
 * conversion-tracking integration.
 *
 * When a visitor interacts with the Converly loader on your marketing site,
 * the loader writes a short-lived `cnv_signup_correlation` cookie. When your
 * backend creates the account, you read that cookie ({@link readCorrelation})
 * and call {@link ConverlyClient.completeSignup} — the SDK signs the request
 * (HMAC-SHA256 over the exact bytes on the wire) and POSTs it to Converly,
 * which fires the conversion to Google Ads / Meta with full match quality.
 *
 * @packageDocumentation
 * @example
 * import { createClient } from '@converly/sdk-node';
 *
 * const converly = createClient({
 *   siteKey:       process.env.CONVERLY_SITE_KEY!,
 *   triggerKey:    'main-signup',
 *   webhookSecret: process.env.CONVERLY_WEBHOOK_SECRET!,
 * });
 *
 * app.post('/signup', async (req, res) => {
 *   const token = converly.readCorrelation(req);
 *   const user = await createUser(req.body);
 *   if (user.created) {
 *     converly
 *       .completeSignup({
 *         correlation_token: token,
 *         customer_event_id: `account_created_${user.id}`,
 *         email: user.email,
 *         allow_uncorrelated: false, // no-op if the visitor never hit the loader
 *       })
 *       .catch((err) => log.warn('converly fire failed', err)); // never crash signup
 *   }
 *   res.redirect('/dashboard');
 * });
 */

export { createClient } from './client';
export { readCorrelation } from './correlation';

export {
  ConverlyError,
  ConverlyConfigError,
  ConverlyValidationError,
  ConverlyAuthError,
  ConverlyRequestError,
  ConverlyServerError,
  ConverlyNetworkError,
} from './errors';
export type { ConverlyErrorCode } from './errors';

export type {
  // client + options
  ConverlyClient,
  CreateClientOptions,
  FetchLike,
  CorrelationSource,
  // completeSignup input
  CompleteSignupInput,
  CompleteSignupCommon,
  CompleteSignupCorrelated,
  CompleteSignupMaybeUncorrelated,
  // completeSignup result union
  CompleteSignupResult,
  CompleteSignupPromoted,
  CompleteSignupPromotedUncorrelated,
  CompleteSignupAwaitingBrowserHalf,
  CompleteSignupNoMatchingFlows,
  CompleteSignupNoPromotion,
  CompleteSignupSkippedUncorrelated,
  CompleteSignupUnknown,
} from './types';
