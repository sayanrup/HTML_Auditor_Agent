/**
 * Service for securely fetching HTML content from URLs.
 */

export interface FetchResult {
  success: boolean;
  html?: string;
  error?: string;
}

/**
 * Validates and fetches HTML content from a given URL.
 * Includes security checks and error handling.
 */
export async function fetchPageHtml(url: string): Promise<FetchResult> {
  try {
    // Validate URL format
    const parsedUrl = new URL(url);

    // Only allow http and https protocols
    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      return {
        success: false,
        error: "Only HTTP and HTTPS protocols are supported",
      };
    }

    // Fetch with timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout

    const isMobileUrl = url.includes("m.indiamart.com");

    const userAgent = isMobileUrl
      ? "Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1"
      : "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36";

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          "User-Agent": userAgent,
        },
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        return {
          success: false,
          error: `HTTP ${response.status}: ${response.statusText}`,
        };
      }

      const contentType = response.headers.get("content-type") || "";
      if (!contentType.includes("text/html")) {
        return {
          success: false,
          error: `Invalid content type: ${contentType}. Expected text/html`,
        };
      }

      const html = await response.text();

      // Check for minimum content length
      if (html.length < 100) {
        return {
          success: false,
          error: "Page content is too small to audit",
        };
      }

      // Check for maximum content length (prevent memory issues)
      if (html.length > 10 * 1024 * 1024) {
        // 10MB limit
        return {
          success: false,
          error: "Page content is too large to audit (max 10MB)",
        };
      }

      return {
        success: true,
        html,
      };
    } catch (fetchError) {
      clearTimeout(timeoutId);

      if (fetchError instanceof Error) {
        if (fetchError.name === "AbortError") {
          return {
            success: false,
            error: "Request timeout (10 seconds)",
          };
        }
        return {
          success: false,
          error: `Fetch error: ${fetchError.message}`,
        };
      }

      return {
        success: false,
        error: "Unknown fetch error",
      };
    }
  } catch (error) {
    if (error instanceof Error) {
      if (error instanceof TypeError) {
        return {
          success: false,
          error: "Invalid URL format",
        };
      }
      return {
        success: false,
        error: `Error: ${error.message}`,
      };
    }

    return {
      success: false,
      error: "Unknown error occurred",
    };
  }
}
