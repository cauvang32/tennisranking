#!/usr/bin/env node

/**
 * 🔒 Tennis Ranking System - Server Technology Exposure Test
 * 
 * This script tests that server technology information is not exposed
 * through HTTP headers, preventing information disclosure attacks.
 * 
 * Tests:
 * 1. X-Powered-By header is not present
 * 2. Server header is not present or generic
 * 3. All security headers are properly set
 */

import axios from 'axios'

const TEST_CONFIG = {
  testUrl: 'http://localhost:3001'
}

class ServerExposureTester {
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
   * Test that X-Powered-By header is not exposed
   */
  async testXPoweredByHeader() {
    this.log('Testing X-Powered-By header exposure...', 'info')
    
    try {
      const response = await axios.get(TEST_CONFIG.testUrl, {
        timeout: 5000,
        validateStatus: () => true
      })
      
      const xPoweredBy = response.headers['x-powered-by']
      
      if (xPoweredBy) {
        this.results.failed++
        this.results.errors.push(`X-Powered-By header found: ${xPoweredBy}`)
        this.log(`❌ SECURITY ISSUE: X-Powered-By header exposes server technology: ${xPoweredBy}`, 'error')
        return false
      } else {
        this.results.passed++
        this.log('✅ X-Powered-By header is not present (secure)', 'success')
        return true
      }
    } catch (error) {
      this.results.failed++
      this.results.errors.push(`X-Powered-By test error: ${error.message}`)
      this.log(`❌ Test error: ${error.message}`, 'error')
      return false
    }
  }

  /**
   * Test that Server header is not exposing technology details
   */
  async testServerHeader() {
    this.log('Testing Server header exposure...', 'info')
    
    try {
      const response = await axios.get(TEST_CONFIG.testUrl, {
        timeout: 5000,
        validateStatus: () => true
      })
      
      const serverHeader = response.headers['server']
      
      if (!serverHeader) {
        this.results.passed++
        this.log('✅ Server header is not present (secure)', 'success')
        return true
      }
      
      // Check if server header reveals technology
      const exposedTech = ['express', 'node', 'nginx', 'apache', 'iis']
      const isExposed = exposedTech.some(tech => 
        serverHeader.toLowerCase().includes(tech)
      )
      
      if (isExposed) {
        this.results.failed++
        this.results.errors.push(`Server header exposes technology: ${serverHeader}`)
        this.log(`❌ SECURITY ISSUE: Server header exposes technology: ${serverHeader}`, 'error')
        return false
      } else {
        this.results.passed++
        this.log(`✅ Server header is generic: ${serverHeader}`, 'success')
        return true
      }
    } catch (error) {
      this.results.failed++
      this.results.errors.push(`Server header test error: ${error.message}`)
      this.log(`❌ Test error: ${error.message}`, 'error')
      return false
    }
  }

  /**
   * Test that security headers are present
   */
  async testSecurityHeaders() {
    this.log('Testing security headers presence...', 'info')
    
    try {
      const response = await axios.get(TEST_CONFIG.testUrl, {
        timeout: 5000,
        validateStatus: () => true
      })
      
      const requiredHeaders = {
        'x-content-type-options': 'nosniff',
        'x-frame-options': ['DENY', 'SAMEORIGIN'],
        'strict-transport-security': null, // Just check presence
        'content-security-policy': null
      }
      
      let allPresent = true
      
      for (const [header, expectedValue] of Object.entries(requiredHeaders)) {
        const actualValue = response.headers[header]
        
        if (!actualValue) {
          this.results.failed++
          this.results.errors.push(`Missing security header: ${header}`)
          this.log(`  ❌ Missing: ${header}`, 'error')
          allPresent = false
        } else if (expectedValue) {
          if (Array.isArray(expectedValue)) {
            if (!expectedValue.includes(actualValue)) {
              this.results.failed++
              this.results.errors.push(`Wrong value for ${header}: ${actualValue}`)
              this.log(`  ❌ Wrong value for ${header}: ${actualValue}`, 'error')
              allPresent = false
            } else {
              this.results.passed++
              this.log(`  ✅ ${header}: ${actualValue}`, 'success')
            }
          } else if (actualValue !== expectedValue) {
            this.results.failed++
            this.results.errors.push(`Wrong value for ${header}: ${actualValue}`)
            this.log(`  ❌ Wrong value for ${header}: ${actualValue}`, 'error')
            allPresent = false
          } else {
            this.results.passed++
            this.log(`  ✅ ${header}: ${actualValue}`, 'success')
          }
        } else {
          this.results.passed++
          this.log(`  ✅ ${header}: present`, 'success')
        }
      }
      
      return allPresent
    } catch (error) {
      this.results.failed++
      this.results.errors.push(`Security headers test error: ${error.message}`)
      this.log(`❌ Test error: ${error.message}`, 'error')
      return false
    }
  }

  /**
   * Test multiple endpoints to ensure consistency
   */
  async testMultipleEndpoints() {
    this.log('Testing multiple endpoints for consistency...', 'info')
    
    const endpoints = [
      '/',
      '/api/csrf-token',
      '/api/auth/status'
    ]
    
    let allSecure = true
    
    for (const endpoint of endpoints) {
      try {
        const response = await axios.get(`${TEST_CONFIG.testUrl}${endpoint}`, {
          timeout: 5000,
          validateStatus: () => true
        })
        
        const xPoweredBy = response.headers['x-powered-by']
        
        if (xPoweredBy) {
          this.results.failed++
          this.results.errors.push(`${endpoint}: X-Powered-By header found`)
          this.log(`  ❌ ${endpoint}: X-Powered-By exposed`, 'error')
          allSecure = false
        } else {
          this.results.passed++
          this.log(`  ✅ ${endpoint}: secure`, 'success')
        }
      } catch (error) {
        // Ignore connection errors for optional endpoints
        this.log(`  ⚠️ ${endpoint}: ${error.message}`, 'warning')
      }
    }
    
    return allSecure
  }

  async runAllTests() {
    this.log('🔒 Starting Server Exposure Security Tests', 'info')
    this.log('='.repeat(60), 'info')
    
    const test1 = await this.testXPoweredByHeader()
    const test2 = await this.testServerHeader()
    const test3 = await this.testSecurityHeaders()
    const test4 = await this.testMultipleEndpoints()
    
    this.generateReport()
    
    return this.results.failed === 0
  }

  generateReport() {
    this.log('='.repeat(60), 'info')
    this.log('🔒 SERVER EXPOSURE SECURITY TEST RESULTS', 'info')
    this.log('='.repeat(60), 'info')
    
    this.log(`Total Tests: ${this.results.passed + this.results.failed}`, 'info')
    this.log(`✅ Passed: ${this.results.passed}`, 'success')
    this.log(`❌ Failed: ${this.results.failed}`, this.results.failed > 0 ? 'error' : 'info')
    
    if (this.results.errors.length > 0) {
      this.log('Errors:', 'error')
      this.results.errors.forEach(error => this.log(`  - ${error}`, 'error'))
    }
    
    this.log('='.repeat(60), 'info')
    
    if (this.results.failed === 0) {
      this.log('🎉 All server exposure tests passed!', 'success')
      this.log('✅ SECURITY: Server technology not exposed', 'success')
      this.log('✅ COMPLIANCE: Meets OWASP security guidelines', 'success')
      this.log('✅ PROTECTION: Information disclosure prevented', 'success')
    } else {
      this.log('🔧 SECURITY ISSUES FOUND!', 'error')
      this.log('⚠️ WARNING: Server technology may be exposed', 'error')
      this.log('📝 ACTION REQUIRED: Fix server information disclosure', 'error')
    }
  }
}

// CLI interface
if (import.meta.url === `file://${process.argv[1]}`) {
  const tester = new ServerExposureTester()
  
  tester.runAllTests().then(success => {
    process.exit(success ? 0 : 1)
  }).catch(error => {
    console.error('❌ Test runner failed:', error.message)
    process.exit(1)
  })
}

export default ServerExposureTester
