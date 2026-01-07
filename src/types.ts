/**
 * GAS Masking Proxy - Type Definitions
 */

// App registration
export interface App {
  id: string;
  name: string;
  url: string;
  createdAt: string;
  updatedAt: string;
}

// Masking rule types
export type MaskingType = 'name' | 'phone' | 'email' | 'address' | 'custom';

export interface MaskingRule {
  id: string;
  selector?: string;
  pattern?: string;
  replacement?: string;
  type: MaskingType;
  enabled: boolean;
}

export interface AppWithRules extends App {
  rules: MaskingRule[];
  useDefaultRules: boolean;
}

// API responses
export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

// Cloudflare Workers environment bindings
export interface Env {
  APPS: KVNamespace;
  SESSIONS: KVNamespace;
  ADMIN_PASSWORD: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
}

// OAuth Session
export interface Session {
  id: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  email: string;
  createdAt: string;
}
