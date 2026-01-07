/**
 * GAS Masking Proxy - Masking Rules and Utilities
 */

import * as cheerio from 'cheerio';
import type { MaskingRule, MaskingType } from './types';

// Default masking rules
interface DefaultRule {
  name: string;
  pattern: RegExp;
  replacement: string | ((match: string) => string);
  type: MaskingType;
}

const DEFAULT_RULES: DefaultRule[] = [
  {
    name: '日本人名（スペースあり）',
    // Matches Japanese names with space: 山田 太郎
    pattern: /[一-龯]{1,3}[　\s][一-龯]{1,4}/g,
    replacement: '山田 太郎',
    type: 'name',
  },
  {
    name: '携帯電話',
    // Matches mobile phone: 090-1234-5678, 09012345678
    pattern: /0[789]0[-ー]?\d{4}[-ー]?\d{4}/g,
    replacement: '090-****-****',
    type: 'phone',
  },
  {
    name: '固定電話',
    // Matches landline: 03-1234-5678, 0312345678
    pattern: /0\d{1,4}[-ー]?\d{1,4}[-ー]?\d{4}/g,
    replacement: '03-****-****',
    type: 'phone',
  },
  {
    name: 'メールアドレス',
    // Matches email addresses
    pattern: /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g,
    replacement: '***@example.com',
    type: 'email',
  },
  {
    name: '住所',
    // Matches Japanese addresses starting with prefecture
    pattern: /(東京都|北海道|(?:京都|大阪)府|[一-龯]{2,3}県)[一-龯]+[市区町村][一-龯0-9０-９\-ー－]+/g,
    replacement: (match: string) => {
      // Keep prefecture and city, mask the rest
      const prefectureMatch = match.match(/(東京都|北海道|(?:京都|大阪)府|[一-龯]{2,3}県)/);
      if (!prefectureMatch) return '***';
      const prefecture = prefectureMatch[0];
      const afterPref = match.slice(prefecture.length);
      const cityMatch = afterPref.match(/[一-龯]+[市区町村]/);
      if (!cityMatch) return prefecture + '***';
      return prefecture + cityMatch[0] + '***';
    },
    type: 'address',
  },
];

/**
 * Apply default masking rules to text
 */
export function applyDefaultMasking(text: string): string {
  let result = text;
  for (const rule of DEFAULT_RULES) {
    if (typeof rule.replacement === 'function') {
      result = result.replace(rule.pattern, rule.replacement);
    } else {
      result = result.replace(rule.pattern, rule.replacement);
    }
  }
  return result;
}

/**
 * Get replacement for masking type
 */
function getReplacementForType(type: MaskingType, original: string): string {
  switch (type) {
    case 'name':
      return '山田 太郎';
    case 'phone':
      return '090-****-****';
    case 'email':
      return '***@example.com';
    case 'address':
      return '東京都渋谷区***';
    case 'custom':
    default:
      return '***';
  }
}

/**
 * Apply custom masking rules to HTML using Cheerio
 */
export function applyCustomRules(html: string, rules: MaskingRule[]): string {
  const $ = cheerio.load(html);

  for (const rule of rules) {
    if (!rule.enabled) continue;

    if (rule.selector) {
      // Selector-based rule
      $(rule.selector).each((_, element) => {
        const $el = $(element);
        const originalText = $el.text();
        if (originalText.trim()) {
          const replacement = rule.replacement || getReplacementForType(rule.type, originalText);
          $el.text(replacement);
        }
      });
    }

    if (rule.pattern) {
      // Pattern-based rule - apply to text nodes
      const pattern = new RegExp(rule.pattern, 'g');
      const replacement = rule.replacement || getReplacementForType(rule.type, '');

      $('*')
        .contents()
        .filter(function () {
          return this.type === 'text';
        })
        .each((_, textNode) => {
          const text = $(textNode).text();
          if (pattern.test(text)) {
            const newText = text.replace(pattern, replacement);
            $(textNode).replaceWith(newText);
          }
        });
    }
  }

  return $.html();
}

/**
 * Apply masking to HTML content
 */
export function maskHtml(html: string, customRules: MaskingRule[], useDefaultRules: boolean): string {
  let result = html;

  // First, remove GAS framework scripts that cause issues
  result = removeGasScripts(result);

  // Apply default rules first if enabled
  if (useDefaultRules) {
    const $ = cheerio.load(result);

    // Apply default masking to all text nodes
    $('*')
      .contents()
      .filter(function () {
        return this.type === 'text';
      })
      .each((_, textNode) => {
        const text = $(textNode).text();
        const masked = applyDefaultMasking(text);
        if (masked !== text) {
          $(textNode).replaceWith(masked);
        }
      });

    result = $.html();
  }

  // Apply custom rules
  if (customRules.length > 0) {
    result = applyCustomRules(result, customRules);
  }

  return result;
}

/**
 * Remove GAS framework scripts that interfere with proxy display
 */
function removeGasScripts(html: string): string {
  const $ = cheerio.load(html);

  // Remove ALL external scripts - GAS apps don't need them for static display
  $('script[src]').remove();

  // Remove inline scripts that reference Google APIs
  $('script').each((_, element) => {
    const content = $(element).html() || '';
    if (content.includes('google') ||
        content.includes('warden') ||
        content.includes('mae_html') ||
        content.includes('script.') ||
        content.length > 100) {  // Remove large inline scripts
      $(element).remove();
    }
  });

  return $.html();
}

/**
 * Rewrite URLs in HTML to go through proxy
 */
export function rewriteUrls(html: string, baseUrl: string, proxyBase: string): string {
  const $ = cheerio.load(html);

  // Rewrite anchor hrefs
  $('a[href]').each((_, element) => {
    const href = $(element).attr('href');
    if (href && !href.startsWith('#') && !href.startsWith('javascript:')) {
      const absoluteUrl = resolveUrl(href, baseUrl);
      if (absoluteUrl.includes('script.google.com') || absoluteUrl.includes('googleusercontent.com')) {
        // Keep GAS links going through proxy
        $(element).attr('href', `${proxyBase}/proxy-resource?url=${encodeURIComponent(absoluteUrl)}`);
      }
    }
  });

  // Rewrite form actions
  $('form[action]').each((_, element) => {
    const action = $(element).attr('action');
    if (action) {
      const absoluteUrl = resolveUrl(action, baseUrl);
      $(element).attr('action', `${proxyBase}/proxy-resource?url=${encodeURIComponent(absoluteUrl)}`);
    }
  });

  // Rewrite CSS links
  $('link[href]').each((_, element) => {
    const href = $(element).attr('href');
    if (href) {
      const absoluteUrl = resolveUrl(href, baseUrl);
      $(element).attr('href', `${proxyBase}/proxy-resource?url=${encodeURIComponent(absoluteUrl)}`);
    }
  });

  // Rewrite script sources
  $('script[src]').each((_, element) => {
    const src = $(element).attr('src');
    if (src) {
      const absoluteUrl = resolveUrl(src, baseUrl);
      $(element).attr('src', `${proxyBase}/proxy-resource?url=${encodeURIComponent(absoluteUrl)}`);
    }
  });

  // Rewrite image sources
  $('img[src]').each((_, element) => {
    const src = $(element).attr('src');
    if (src) {
      const absoluteUrl = resolveUrl(src, baseUrl);
      $(element).attr('src', `${proxyBase}/proxy-resource?url=${encodeURIComponent(absoluteUrl)}`);
    }
  });

  return $.html();
}

/**
 * Resolve relative URL to absolute URL
 */
export function resolveUrl(url: string, baseUrl: string): string {
  if (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('//')) {
    if (url.startsWith('//')) {
      return 'https:' + url;
    }
    return url;
  }

  try {
    return new URL(url, baseUrl).href;
  } catch {
    return url;
  }
}

/**
 * Extract iframe src from GAS HTML
 * GAS apps embed actual content in a sandboxed iframe
 */
export function extractIframeSrc(html: string): string | null {
  const $ = cheerio.load(html);
  const iframe = $('iframe[src*="googleusercontent.com"]');
  if (iframe.length > 0) {
    return iframe.attr('src') || null;
  }
  return null;
}

/**
 * Extract userHtml from GAS page
 * GAS embeds the actual HTML content in a JavaScript variable called userHtml
 */
export function extractUserHtml(html: string): string | null {
  // Look for the userHtml property in the goog.script.init() call
  const userHtmlMatch = html.match(/"userHtml":"((?:[^"\\]|\\.)*)"/);
  if (userHtmlMatch && userHtmlMatch[1]) {
    // Decode the escaped string
    let decoded = userHtmlMatch[1];
    // Decode hex escapes like \x3c -> <
    decoded = decoded.replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16))
    );
    // Decode unicode escapes
    decoded = decoded.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16))
    );
    // Decode standard escapes
    decoded = decoded.replace(/\\n/g, '\n');
    decoded = decoded.replace(/\\r/g, '\r');
    decoded = decoded.replace(/\\t/g, '\t');
    decoded = decoded.replace(/\\"/g, '"');
    decoded = decoded.replace(/\\\//g, '/');
    decoded = decoded.replace(/\\\\/g, '\\');
    return decoded;
  }
  return null;
}
