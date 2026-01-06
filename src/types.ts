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
  ADMIN_PASSWORD: string;
}
