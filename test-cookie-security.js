#!/usr/bin/env node
/**
 * Cookie Security Test Script
 * Tests all cookies in the Tennis Ranking System for proper security flags
 */

import https from 'https';
import http from 'http';

const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m'
};

const API_URL = process.env.API_URL || 'http://localhost:3001';
const ADMIN_USER = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASSWORD || 'tennis2024!';

console.log(`${colors.blue}╔════════════════════════════════════════════════════════════╗${colors.reset}`);
console.log(`${colors.blue}║       🔒 Cookie Security Test - Tennis Ranking System      ║${colors.reset}`);
console.log(`${colors.blue}╚════════════════════════════════════════════════════════════╝${colors.reset}`);
console.log('');

/**
 * Parse Set-Cookie header and extract cookie attributes
 */
function parseCookie(setCookieHeader) {
  if (!setCookieHeader) return null;
  
  const parts = setCookieHeader.split(';').map(p => p.trim());
  const [nameValue] = parts;
  const [name, value] = nameValue.split('=');
  
  const cookie = {
    name,
    value,
    httpOnly: parts.some(p => p.toLowerCase() === 'httponly'),
    secure: parts.some(p => p.toLowerCase() === 'secure'),
    sameSite: null,
    path: null,
    maxAge: null,
    domain: null
  };
  
  parts.forEach(part => {
    const lower = part.toLowerCase();
    if (lower.startsWith('samesite=')) {
      cookie.sameSite = part.split('=')[1];
    } else if (lower.startsWith('path=')) {
      cookie.path = part.split('=')[1];
    } else if (lower.startsWith('max-age=')) {
      cookie.maxAge = parseInt(part.split('=')[1]);
    } else if (lower.startsWith('domain=')) {
      cookie.domain = part.split('=')[1];
    }
  });
  
  return cookie;
}

/**
 * Make HTTP request and return response with cookies
 */
function makeRequest(path, method = 'GET', data = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, API_URL);
    const isHttps = url.protocol === 'https:';
    const client = isHttps ? https : http;
    
    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...headers
      }
    };
    
    if (data) {
      const body = JSON.stringify(data);
      options.headers['Content-Length'] = Buffer.byteLength(body);
    }
    
    const req = client.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        const cookies = [];
        const setCookieHeaders = res.headers['set-cookie'] || [];
        setCookieHeaders.forEach(header => {
          const cookie = parseCookie(header);
          if (cookie) cookies.push(cookie);
        });
        
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          cookies,
          body: body ? JSON.parse(body) : null
        });
      });
    });
    
    req.on('error', reject);
    
    if (data) {
      req.write(JSON.stringify(data));
    }
    
    req.end();
  });
}

/**
 * Test cookie security attributes
 */
function testCookie(cookie, expectedAttributes) {
  const results = [];
  
  // Test httpOnly
  if (expectedAttributes.httpOnly) {
    if (cookie.httpOnly) {
      results.push(`${colors.green}✓${colors.reset} httpOnly: true`);
    } else {
      results.push(`${colors.red}✗${colors.reset} httpOnly: false (SECURITY ISSUE!)`);
    }
  }
  
  // Test secure (only in production)
  if (expectedAttributes.secure) {
    if (cookie.secure) {
      results.push(`${colors.green}✓${colors.reset} secure: true`);
    } else {
      results.push(`${colors.yellow}⚠${colors.reset} secure: false (OK in dev, ISSUE in production)`);
    }
  }
  
  // Test sameSite
  if (expectedAttributes.sameSite) {
    if (cookie.sameSite && cookie.sameSite.toLowerCase() === expectedAttributes.sameSite.toLowerCase()) {
      results.push(`${colors.green}✓${colors.reset} sameSite: ${cookie.sameSite}`);
    } else {
      results.push(`${colors.red}✗${colors.reset} sameSite: ${cookie.sameSite || 'not set'} (Expected: ${expectedAttributes.sameSite})`);
    }
  }
  
  // Test path
  if (cookie.path) {
    results.push(`${colors.cyan}ℹ${colors.reset} path: ${cookie.path}`);
  }
  
  // Test maxAge
  if (cookie.maxAge) {
    const hours = Math.round(cookie.maxAge / 3600);
    results.push(`${colors.cyan}ℹ${colors.reset} maxAge: ${cookie.maxAge}s (${hours}h)`);
  }
  
  return results;
}

/**
 * Main test suite
 */
async function runTests() {
  let testsPassed = 0;
  let testsFailed = 0;
  
  try {
    // Test 1: Login and check authToken cookie
    console.log(`${colors.yellow}Test 1: Login and check authToken cookie${colors.reset}`);
    console.log('─────────────────────────────────────────────────');
    
    const loginRes = await makeRequest('/api/auth/login', 'POST', {
      username: ADMIN_USER,
      password: ADMIN_PASS
    });
    
    if (loginRes.statusCode === 200) {
      console.log(`${colors.green}✓${colors.reset} Login successful`);
      
      const authTokenCookie = loginRes.cookies.find(c => c.name === 'authToken');
      const csrfCookie = loginRes.cookies.find(c => c.name === 'csrfSessionId');
      
      if (authTokenCookie) {
        console.log(`${colors.green}✓${colors.reset} authToken cookie found`);
        const results = testCookie(authTokenCookie, {
          httpOnly: true,
          secure: API_URL.startsWith('https'),
          sameSite: 'Strict'
        });
        results.forEach(r => console.log(`  ${r}`));
        
        if (authTokenCookie.httpOnly) {
          testsPassed++;
        } else {
          testsFailed++;
          console.log(`${colors.red}✗ CRITICAL: authToken missing httpOnly flag!${colors.reset}`);
        }
      } else {
        testsFailed++;
        console.log(`${colors.red}✗${colors.reset} authToken cookie not found`);
      }
      
      console.log('');
      
      if (csrfCookie) {
        console.log(`${colors.green}✓${colors.reset} csrfSessionId cookie found`);
        const results = testCookie(csrfCookie, {
          httpOnly: true,
          secure: API_URL.startsWith('https'),
          sameSite: 'Strict'
        });
        results.forEach(r => console.log(`  ${r}`));
        
        if (csrfCookie.httpOnly) {
          testsPassed++;
        } else {
          testsFailed++;
          console.log(`${colors.red}✗ CRITICAL: csrfSessionId missing httpOnly flag!${colors.reset}`);
        }
      } else {
        testsFailed++;
        console.log(`${colors.red}✗${colors.reset} csrfSessionId cookie not found`);
      }
    } else {
      testsFailed++;
      console.log(`${colors.red}✗${colors.reset} Login failed: ${loginRes.statusCode}`);
      console.log(`  Response: ${JSON.stringify(loginRes.body)}`);
    }
    
    console.log('');
    console.log('─────────────────────────────────────────────────');
    
    // Test 2: Get CSRF token
    console.log(`${colors.yellow}Test 2: Get CSRF token (public endpoint)${colors.reset}`);
    console.log('─────────────────────────────────────────────────');
    
    const csrfRes = await makeRequest('/api/csrf-token', 'GET');
    
    if (csrfRes.statusCode === 200) {
      console.log(`${colors.green}✓${colors.reset} CSRF token endpoint accessible`);
      
      const csrfCookie = csrfRes.cookies.find(c => c.name === 'csrfSessionId');
      
      if (csrfCookie) {
        console.log(`${colors.green}✓${colors.reset} csrfSessionId cookie set`);
        const results = testCookie(csrfCookie, {
          httpOnly: true,
          secure: API_URL.startsWith('https'),
          sameSite: 'Strict'
        });
        results.forEach(r => console.log(`  ${r}`));
        
        if (csrfCookie.httpOnly) {
          testsPassed++;
        } else {
          testsFailed++;
          console.log(`${colors.red}✗ CRITICAL: csrfSessionId missing httpOnly flag!${colors.reset}`);
        }
      } else {
        console.log(`${colors.yellow}⚠${colors.reset} csrfSessionId cookie not set (may already exist)`);
      }
    } else {
      testsFailed++;
      console.log(`${colors.red}✗${colors.reset} CSRF token endpoint failed: ${csrfRes.statusCode}`);
    }
    
    console.log('');
    console.log('─────────────────────────────────────────────────');
    
  } catch (error) {
    console.error(`${colors.red}✗ Test failed with error:${colors.reset}`, error.message);
    testsFailed++;
  }
  
  // Summary
  console.log('');
  console.log(`${colors.blue}╔════════════════════════════════════════════════════════════╗${colors.reset}`);
  console.log(`${colors.blue}║                       Test Summary                         ║${colors.reset}`);
  console.log(`${colors.blue}╚════════════════════════════════════════════════════════════╝${colors.reset}`);
  console.log('');
  console.log(`Total Tests: ${testsPassed + testsFailed}`);
  console.log(`${colors.green}Passed: ${testsPassed}${colors.reset}`);
  console.log(`${colors.red}Failed: ${testsFailed}${colors.reset}`);
  console.log('');
  
  if (testsFailed === 0) {
    console.log(`${colors.green}✓ All cookie security tests passed!${colors.reset}`);
    console.log(`${colors.green}✓ No security vulnerabilities detected.${colors.reset}`);
    process.exit(0);
  } else {
    console.log(`${colors.red}✗ Some tests failed. Please review the results above.${colors.reset}`);
    process.exit(1);
  }
}

// Run tests
runTests().catch(error => {
  console.error(`${colors.red}Fatal error:${colors.reset}`, error);
  process.exit(1);
});
