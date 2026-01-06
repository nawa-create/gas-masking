/**
 * GAS Masking Proxy - Proxy Functionality
 */

import { maskHtml, rewriteUrls, extractIframeSrc } from './masking';
import type { MaskingRule } from './types';

/**
 * Fetch HTML from a URL with proper headers
 */
export async function fetchHtml(url: string): Promise<{ html: string; contentType: string }> {
  const response = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
    },
    redirect: 'follow',
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch: ${response.status} ${response.statusText}`);
  }

  const contentType = response.headers.get('content-type') || 'text/html';
  const html = await response.text();
  return { html, contentType };
}

/**
 * Fetch GAS app content including iframe content
 */
export async function fetchGasContent(gasUrl: string): Promise<{ html: string; finalUrl: string }> {
  // First, fetch the main GAS page
  const { html: mainHtml } = await fetchHtml(gasUrl);

  // Check if there's an iframe (GAS apps embed content in sandboxed iframe)
  const iframeSrc = extractIframeSrc(mainHtml);

  if (iframeSrc) {
    // Fetch the iframe content (the actual app)
    const { html: iframeHtml } = await fetchHtml(iframeSrc);
    return { html: iframeHtml, finalUrl: iframeSrc };
  }

  // No iframe, return the main HTML
  return { html: mainHtml, finalUrl: gasUrl };
}

/**
 * Process and mask GAS app content
 */
export async function processGasApp(
  gasUrl: string,
  customRules: MaskingRule[],
  useDefaultRules: boolean,
  proxyBase: string
): Promise<string> {
  // Fetch the GAS content
  const { html, finalUrl } = await fetchGasContent(gasUrl);

  // Apply masking
  let maskedHtml = maskHtml(html, customRules, useDefaultRules);

  // Rewrite URLs to go through proxy
  maskedHtml = rewriteUrls(maskedHtml, finalUrl, proxyBase);

  // Add proxy meta tag for base URL handling
  maskedHtml = injectProxyMeta(maskedHtml, proxyBase);

  return maskedHtml;
}

/**
 * Inject proxy metadata and scripts for dynamic content handling
 */
function injectProxyMeta(html: string, proxyBase: string): string {
  const proxyScript = `
<script>
// GAS Masking Proxy - Client-side support
(function() {
  const PROXY_BASE = '${proxyBase}';

  // Override XMLHttpRequest to go through proxy
  const originalXHROpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, async, user, password) {
    if (url && typeof url === 'string' && (url.includes('script.google.com') || url.includes('googleusercontent.com'))) {
      url = PROXY_BASE + '/proxy-resource?url=' + encodeURIComponent(url);
    }
    return originalXHROpen.call(this, method, url, async, user, password);
  };

  // Override fetch to go through proxy
  const originalFetch = window.fetch;
  window.fetch = function(input, init) {
    if (typeof input === 'string' && (input.includes('script.google.com') || input.includes('googleusercontent.com'))) {
      input = PROXY_BASE + '/proxy-resource?url=' + encodeURIComponent(input);
    }
    return originalFetch.call(this, input, init);
  };
})();
</script>
`;

  // Inject script before closing body tag
  if (html.includes('</body>')) {
    return html.replace('</body>', proxyScript + '</body>');
  } else if (html.includes('</html>')) {
    return html.replace('</html>', proxyScript + '</html>');
  } else {
    return html + proxyScript;
  }
}

/**
 * Proxy a resource (CSS, JS, images, etc.)
 */
export async function proxyResource(
  resourceUrl: string
): Promise<{ content: ArrayBuffer; contentType: string }> {
  const response = await fetch(resourceUrl, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: '*/*',
    },
    redirect: 'follow',
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch resource: ${response.status} ${response.statusText}`);
  }

  const contentType = response.headers.get('content-type') || 'application/octet-stream';
  const content = await response.arrayBuffer();

  return { content, contentType };
}

/**
 * Handle POST requests and forward to GAS
 */
export async function forwardPost(
  gasUrl: string,
  body: string | ArrayBuffer,
  contentType: string,
  customRules: MaskingRule[],
  useDefaultRules: boolean,
  proxyBase: string
): Promise<string> {
  const response = await fetch(gasUrl, {
    method: 'POST',
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Content-Type': contentType,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
    body: body,
    redirect: 'follow',
  });

  const responseContentType = response.headers.get('content-type') || 'text/html';

  // If HTML response, mask it
  if (responseContentType.includes('text/html')) {
    const html = await response.text();

    // Check for iframe in response
    const iframeSrc = extractIframeSrc(html);
    let contentToMask = html;
    let baseUrl = gasUrl;

    if (iframeSrc) {
      const { html: iframeHtml } = await fetchHtml(iframeSrc);
      contentToMask = iframeHtml;
      baseUrl = iframeSrc;
    }

    let maskedHtml = maskHtml(contentToMask, customRules, useDefaultRules);
    maskedHtml = rewriteUrls(maskedHtml, baseUrl, proxyBase);
    maskedHtml = injectProxyMeta(maskedHtml, proxyBase);

    return maskedHtml;
  }

  // For non-HTML responses, return as-is
  return response.text();
}
