/**
 * CSRF Protection Module
 *
 * Implements comprehensive Cross-Site Request Forgery (CSRF) protection using:
 * 1. Double-Submit Cookie Pattern - CSRF tokens in both cookie and header
 * 2. Origin/Referer Header Validation - Validates request origin
 * 3. WebSocket Origin Validation - Prevents cross-origin WebSocket attacks
 *
 * Security Design:
 * - Uses cryptographically secure random tokens (32 bytes)
 * - Signed cookies prevent token tampering
 * - Defense-in-depth: multiple validation layers
 * - Configurable allowed origins via environment variables
 */
import { NextFunction, Request, Response } from "express";
/**
 * CSRF Configuration
 * Loads and validates CSRF settings from environment variables
 */
export interface CsrfConfig {
    /** List of allowed origins for CSRF validation (e.g., ["https://app.example.com"]) */
    allowedOrigins: string[];
    /** Cookie name for CSRF token storage */
    cookieName: string;
    /** Header name for CSRF token submission */
    headerName: string;
    /** Secret key for signing CSRF tokens */
    signingSecret: string;
    /** Enable CSRF protection (default: true) */
    enabled: boolean;
}
/**
 * Load CSRF configuration from environment variables
 *
 * Environment Variables:
 * - CSRF_ALLOWED_ORIGINS: Comma-separated list of allowed origins (default: "same-origin")
 * - CSRF_SIGNING_SECRET: Secret for signing tokens (required in production)
 * - CSRF_ENABLED: Enable/disable CSRF protection (default: "true")
 *
 * @returns Validated CSRF configuration
 */
export declare function loadCsrfConfig(): CsrfConfig;
/**
 * Generate a cryptographically secure CSRF token
 * Returns a signed token in format: token.signature
 *
 * CSRF Protection Enhancement: Uses 32-byte random token with HMAC-SHA256 signature
 *
 * @param secret - Secret key for signing the token
 * @returns Signed CSRF token string
 */
export declare function generateCsrfToken(secret: string): string;
/**
 * Verify a CSRF token's signature
 * Uses timing-safe comparison to prevent timing attacks
 *
 * CSRF Protection Enhancement: Timing-safe comparison prevents timing attacks
 *
 * @param signedToken - Token in format: token.signature
 * @param secret - Secret key used for signing
 * @returns true if token is valid, false otherwise
 */
export declare function verifyCsrfToken(signedToken: string, secret: string): boolean;
/**
 * Validate Origin or Referer header against allowed origins
 *
 * CSRF Protection Enhancement: Validates request origin to prevent cross-site requests
 *
 * @param originHeader - Value of Origin or Referer header
 * @param allowedOrigins - List of allowed origins
 * @param requestHost - Host of the current request (for same-origin check)
 * @returns true if origin is allowed, false otherwise
 */
export declare function validateOrigin(originHeader: string | undefined, allowedOrigins: string[], requestHost: string | undefined): boolean;
/**
 * CSRF Token Validation Middleware
 * Validates CSRF tokens on state-changing HTTP requests (POST, PUT, PATCH, DELETE)
 *
 * Security Flow:
 * 1. Skip validation for safe methods (GET, HEAD, OPTIONS)
 * 2. Validate Origin/Referer header
 * 3. Validate CSRF token from header against cookie
 * 4. Reject request if any validation fails
 *
 * CSRF Protection Enhancement: Multi-layered validation (origin + token)
 *
 * @param config - CSRF configuration
 * @returns Express middleware function
 */
export declare function csrfProtection(config: CsrfConfig): (req: Request, res: Response, next: NextFunction) => void | Response<any, Record<string, any>>;
/**
 * CSRF Token Endpoint Middleware
 * Provides endpoint for clients to retrieve CSRF tokens
 * Sets token in cookie and returns it in response
 *
 * Usage: GET /csrf-token
 * Response: { token: "..." }
 *
 * CSRF Protection Enhancement: Clients can retrieve token before making state-changing requests
 *
 * @param config - CSRF configuration
 * @returns Express middleware function
 */
export declare function csrfTokenEndpoint(config: CsrfConfig): (req: Request, res: Response) => Response<any, Record<string, any>>;
/**
 * Validate WebSocket Origin header during handshake
 * Prevents cross-origin WebSocket connections
 *
 * CSRF Protection Enhancement: Critical protection for WebSocket endpoints
 *
 * @param originHeader - Origin header from WebSocket handshake
 * @param config - CSRF configuration
 * @param requestHost - Host of the request
 * @returns true if origin is valid, false otherwise
 */
export declare function validateWebSocketOrigin(originHeader: string | undefined, config: CsrfConfig, requestHost: string | undefined): boolean;
//# sourceMappingURL=csrf.d.ts.map