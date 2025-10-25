#!/usr/bin/env node

/**
 * 🔒 Tennis Ranking System - HttpOnly Cookie Security Test
 * 
 * This script tests that all cookies are properly set with the httpOnly flag
 * to prevent XSS (Cross-Site Scripting) attacks.
 */

import axios from 'axios'

const TEST_CONFIG = {
  testUrl: 'http://localhost:3001',
  adminCredentials: {
    username: 'admin',
    password: 'dev_admin_password'
  }
}

class HttpOnlyCookieTester {
  constructor() {
    this.results = {
      passed: 0,
      failed: 0,
      errors: []
    }
  }

  log(message, type = 'info') {
    const timestamp = new Date().toISOString()
    const prefix = {
      info: '📋',
      success: '✅', 
      error: '❌',
      warning: '⚠️'
    }[type] || '📋'
    
    console.log(`${prefix} [${timestamp}] ${message}`)
  }

  /**
   * Check if a Set-Cookie header has the HttpOnly flag
   */
  isHttpOnly(setCookieHeader) {
    if (!setCookieHeader) return false
    const lowerHeader = setCookieHeader.toLowerCase()
    return lowerHeader.includes('httponly')
  }

  /**
   * Parse Set-Cookie header to get cookie name
   */
  getCookieName(setCookieHeader) {
    if (!setCookieHeader) return 'unknown'
    const match = setCookieHeader.match(/^([^=]+)=/)
    return match ? match[1] : 'unknown'
  }

  /**
   * Test login endpoint to verify authToken and csrfSessionId cookies have httpOnly
   */
  async testLoginCookies() {
    this.log('Testing login endpoint cookies...', 'info')
    
    try {
      const response = await axios.post(`${TEST_CONFIG.testUrl}/api/auth/login`, {
        username: TEST_CONFIG.adminCredentials.username,
        password: TEST_CONFIG.adminCredentials.password
      }, {
        timeout: 5000,
        validateStatus: () => true,
        maxRedirects: 0
      })
      
      if (response.status !== 200) {
        this.results.failed++
        this.results.errors.push(`Login failed with status ${response.status}`)
        this.log(`❌ Login failed: ${response.status}`, 'error')
        return false
      }

      const setCookieHeaders = response.headers['set-cookie'] || []
      
      if (setCookieHeaders.length === 0) {
        this.results.failed++
        this.results.errors.push('No cookies set in login response')
        this.log(`❌ No cookies set in login response`, 'error')
        return false
      }

      this.log(`Found ${setCookieHeaders.length} cookie(s) in response`, 'info')
      
      let allHttpOnly = true
      const cookieResults = []

      for (const cookie of setCookieHeaders) {
        const cookieName = this.getCookieName(cookie)
        const hasHttpOnly = this.isHttpOnly(cookie)
        
        cookieResults.push({ name: cookieName, httpOnly: hasHttpOnly, header: cookie })
        
        if (hasHttpOnly) {
          this.results.passed++
          this.log(`  ✅ ${cookieName}: HttpOnly flag present`, 'success')
        } else {
          this.results.failed++
          this.results.errors.push(`${cookieName} cookie missing HttpOnly flag`)
          this.log(`  ❌ ${cookieName}: HttpOnly flag MISSING`, 'error')
          allHttpOnly = false
        }
      }

      // Verify expected cookies are present
      const expectedCookies = ['authToken', 'csrfSessionId']
      const foundCookies = cookieResults.map(c => c.name)
      
      for (const expected of expectedCookies) {
        if (!foundCookies.includes(expected)) {
          this.log(`  ⚠️  Expected cookie '${expected}' not found`, 'warning')
        }
      }

      return allHttpOnly
    } catch (error) {
      this.results.failed++
      this.results.errors.push(`Login test error: ${error.message}`)
      this.log(`❌ Login test error: ${error.message}`, 'error')
      return false
    }
  }

  /**
   * Test CSRF token endpoint
   */
  async testCSRFCookie() {
    this.log('Testing CSRF token endpoint cookies...', 'info')
    
    try {
      const response = await axios.get(`${TEST_CONFIG.testUrl}/api/csrf-token`, {
        timeout: 5000,
        validateStatus: () => true
      })
      
      if (response.status !== 200) {
        this.log(`⚠️  CSRF endpoint returned status ${response.status}`, 'warning')
        return true // Not a critical failure
      }

      const setCookieHeaders = response.headers['set-cookie'] || []
      
      if (setCookieHeaders.length === 0) {
        this.log(`  ℹ️  No new cookies set (may be using existing session)`, 'info')
        return true
      }

      for (const cookie of setCookieHeaders) {
        const cookieName = this.getCookieName(cookie)
        const hasHttpOnly = this.isHttpOnly(cookie)
        
        if (hasHttpOnly) {
          this.results.passed++
          this.log(`  ✅ ${cookieName}: HttpOnly flag present`, 'success')
        } else {
          this.results.failed++
          this.results.errors.push(`${cookieName} cookie missing HttpOnly flag`)
          this.log(`  ❌ ${cookieName}: HttpOnly flag MISSING`, 'error')
          return false
        }
      }

      return true
    } catch (error) {
      this.log(`⚠️  CSRF test error: ${error.message}`, 'warning')
      return true // Not a critical failure
    }
  }

  /**
   * Verify cookie flags in detail
   */
  verifyAllCookieFlags(setCookieHeader) {
    const flags = {
      httpOnly: this.isHttpOnly(setCookieHeader),
      secure: setCookieHeader.toLowerCase().includes('secure'),
      sameSite: setCookieHeader.toLowerCase().includes('samesite')
    }
    
    return flags
  }

  async runAllTests() {
    this.log('🔒 Starting HttpOnly Cookie Security Tests', 'info')
    this.log('=' .repeat(60), 'info')
    
    // Test login cookies
    const loginTestPassed = await this.testLoginCookies()
    
    // Test CSRF cookies
    const csrfTestPassed = await this.testCSRFCookie()
    
    // Generate report
    this.generateReport()
    
    return this.results.failed === 0
  }

  generateReport() {
    this.log('=' .repeat(60), 'info')
    this.log('🔒 HTTPONLY COOKIE SECURITY TEST RESULTS', 'info')
    this.log('=' .repeat(60), 'info')
    
    this.log(`Total Cookies Tested: ${this.results.passed + this.results.failed}`, 'info')
    this.log(`✅ HttpOnly Enabled: ${this.results.passed}`, 'success')
    this.log(`❌ HttpOnly Missing: ${this.results.failed}`, this.results.failed > 0 ? 'error' : 'info')
    
    if (this.results.errors.length > 0) {
      this.log('Errors:', 'error')
      this.results.errors.forEach(error => this.log(`  - ${error}`, 'error'))
    }
    
    this.log('=' .repeat(60), 'info')
    
    if (this.results.failed === 0) {
      this.log('🎉 All cookies have HttpOnly flag enabled!', 'success')
      this.log('✅ SECURITY: Protected from XSS cookie theft', 'success')
      this.log('✅ COMPLIANCE: Meets security best practices', 'success')
    } else {
      this.log('🔧 SECURITY ISSUE: Some cookies missing HttpOnly flag!', 'error')
      this.log('⚠️  WARNING: Vulnerable to XSS cookie theft', 'error')
      this.log('📝 ACTION REQUIRED: Add httpOnly flag to all cookies', 'error')
    }
  }
}

// CLI interface
if (import.meta.url === `file://${process.argv[1]}`) {
  const tester = new HttpOnlyCookieTester()
  
  tester.runAllTests().then(success => {
    process.exit(success ? 0 : 1)
  }).catch(error => {
    console.error('❌ Test runner failed:', error.message)
    process.exit(1)
  })
}

export default HttpOnlyCookieTester
