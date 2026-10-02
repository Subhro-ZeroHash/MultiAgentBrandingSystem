import { z } from 'zod';

/** A privacy policy is versioned by its "last updated" date. */
export const privacyPolicyVersionSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected the policy date as YYYY-MM-DD');

export const signupInputSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(8).max(200),
  name: z.string().min(1).max(120).optional(),
  /** The policy version accepted on the sign-up form. Optional so clients
   *  that don't ask yet (the phone app) can still sign up; those users are
   *  asked on their next website visit. */
  acceptedPrivacyPolicyVersion: privacyPolicyVersionSchema.optional(),
});
export type SignupInput = z.infer<typeof signupInputSchema>;

export const loginInputSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(1).max(200),
});
export type LoginInput = z.infer<typeof loginInputSchema>;

export const authUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string().nullable(),
  /** Last privacy policy version accepted; null if never. */
  privacyPolicyVersion: z.string().nullable(),
});
export type AuthUser = z.infer<typeof authUserSchema>;

export const authResponseSchema = z.object({
  user: authUserSchema,
  accessToken: z.string(),
  refreshToken: z.string(),
});
export type AuthResponse = z.infer<typeof authResponseSchema>;

export const acceptPrivacyInputSchema = z.object({
  version: privacyPolicyVersionSchema,
});
export type AcceptPrivacyInput = z.infer<typeof acceptPrivacyInputSchema>;

export const refreshInputSchema = z.object({
  refreshToken: z.string().min(1),
});
export type RefreshInput = z.infer<typeof refreshInputSchema>;

export const logoutInputSchema = z.object({
  refreshToken: z.string().min(1),
});
export type LogoutInput = z.infer<typeof logoutInputSchema>;

export const forgotPasswordInputSchema = z.object({
  email: z.string().email().max(255),
});
export type ForgotPasswordInput = z.infer<typeof forgotPasswordInputSchema>;

export const resetPasswordInputSchema = z.object({
  email: z.string().email().max(255),
  code: z.string().length(6),
  newPassword: z.string().min(8).max(200),
});
export type ResetPasswordInput = z.infer<typeof resetPasswordInputSchema>;
