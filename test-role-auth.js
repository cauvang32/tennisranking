#!/usr/bin/env node

/**
 * 🎾 Tennis Ranking System - Role-Based Authentication Test
 * 
 * This script tests the new role-based authentication system:
 * - Admin account: Full access (create, edit, delete players, matches, seasons)
 * - Editor account: Limited access (edit matches only)
 * - Guest: View-only access
 */

import axios from 'axios'

const TEST_CONFIG = {
  testUrl: 'http://localhost:3001',
  adminCredentials: {
    username: 'admin',
    password: 'dev_admin_password'
  },
  editorCredentials: {
    username: 'editor', 
    password: 'dev_editor_password'
  }
}

class RoleAuthTester {
  constructor() {
    this.results = {
      adminTests: { passed: 0, failed: 0, errors: [] },
      editorTests: { passed: 0, failed: 0, errors: [] },
      guestTests: { passed: 0, failed: 0, errors: [] }
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

  async testLogin(credentials, expectedRole) {
    try {
      const response = await axios.post(`${TEST_CONFIG.testUrl}/api/auth/login`, {
        username: credentials.username,
        password: credentials.password
      }, {
        timeout: 5000,
        validateStatus: () => true
      })
      
      if (response.status === 200 && response.data.user && response.data.user.role === expectedRole) {
        this.log(`✅ Login successful: ${credentials.username} (${expectedRole})`, 'success')
        return { 
          success: true, 
          token: response.data.token,
          cookies: response.headers['set-cookie'],
          user: response.data.user
        }
      } else {
        this.log(`❌ Login failed for ${credentials.username}: ${response.status}`, 'error')
        return { success: false }
      }
    } catch (error) {
      this.log(`❌ Login error for ${credentials.username}: ${error.message}`, 'error')
      return { success: false }
    }
  }

  async testPermissions(authHeaders, role, testName) {
    const results = { passed: 0, failed: 0, errors: [] }
    
    this.log(`Testing ${role} permissions...`, 'info')
    
    // Test cases with expected access levels
    const testCases = [
      // Public endpoints (everyone should access)
      { method: 'GET', url: '/api/players', expectAccess: true, name: 'View players' },
      { method: 'GET', url: '/api/matches', expectAccess: true, name: 'View matches' },
      { method: 'GET', url: '/api/seasons', expectAccess: true, name: 'View seasons' },
      
      // Admin-only endpoints
      { method: 'POST', url: '/api/players', expectAccess: role === 'admin', name: 'Create player', data: { name: 'Test Player' } },
      { method: 'DELETE', url: '/api/players/999', expectAccess: role === 'admin', name: 'Delete player' },
      { method: 'POST', url: '/api/seasons', expectAccess: role === 'admin', name: 'Create season', data: { name: 'Test Season', startDate: '2025-01-01' } },
      { method: 'POST', url: '/api/matches', expectAccess: role === 'admin', name: 'Create match', data: { player1Id: 1, player2Id: 2, player3Id: 3, player4Id: 4, team1Score: 6, team2Score: 4, winningTeam: 1, playDate: '2025-01-01', seasonId: 1 } },
      { method: 'DELETE', url: '/api/matches/999', expectAccess: role === 'admin', name: 'Delete match' },
      
      // Editor endpoints (admin + editor access)
      { method: 'PUT', url: '/api/matches/999', expectAccess: role === 'admin' || role === 'editor', name: 'Edit match', data: { player1Id: 1, player2Id: 2, player3Id: 3, player4Id: 4, team1Score: 6, team2Score: 3, winningTeam: 1, playDate: '2025-01-01', seasonId: 1 } }
    ]
    
    for (const testCase of testCases) {
      try {
        const config = {
          method: testCase.method,
          url: `${TEST_CONFIG.testUrl}${testCase.url}`,
          headers: authHeaders,
          data: testCase.data,
          timeout: 5000,
          validateStatus: () => true
        }
        
        const response = await axios(config)
        const hasAccess = response.status !== 401 && response.status !== 403
        
        if (hasAccess === testCase.expectAccess) {
          results.passed++
          this.log(`  ✅ ${testCase.name}: ${hasAccess ? 'Allowed' : 'Denied'} (Expected: ${testCase.expectAccess ? 'Allow' : 'Deny'})`, 'success')
        } else {
          results.failed++
          results.errors.push(`${testCase.name}: Expected ${testCase.expectAccess ? 'Allow' : 'Deny'}, got ${hasAccess ? 'Allow' : 'Deny'} (Status: ${response.status})`)
          this.log(`  ❌ ${testCase.name}: ${hasAccess ? 'Allowed' : 'Denied'} (Expected: ${testCase.expectAccess ? 'Allow' : 'Deny'}) - Status: ${response.status}`, 'error')
        }
      } catch (error) {
        results.failed++
        results.errors.push(`${testCase.name}: ${error.message}`)
        this.log(`  ❌ ${testCase.name}: Error - ${error.message}`, 'error')
      }
    }
    
    return results
  }

  async runAllTests() {
    this.log('🚀 Starting Role-Based Authentication Tests', 'info')
    this.log('=' * 60, 'info')
    
    // Test Admin Role
    this.log('🔹 Testing Admin Role', 'info')
    const adminLogin = await this.testLogin(TEST_CONFIG.adminCredentials, 'admin')
    if (adminLogin.success) {
      const adminHeaders = {}
      if (adminLogin.token) {
        adminHeaders['Authorization'] = `Bearer ${adminLogin.token}`
      }
      this.results.adminTests = await this.testPermissions(adminHeaders, 'admin', 'Admin')
    } else {
      this.results.adminTests.failed = 1
      this.results.adminTests.errors.push('Admin login failed')
    }
    
    // Test Editor Role
    this.log('🔹 Testing Editor Role', 'info')
    const editorLogin = await this.testLogin(TEST_CONFIG.editorCredentials, 'editor')
    if (editorLogin.success) {
      const editorHeaders = {}
      if (editorLogin.token) {
        editorHeaders['Authorization'] = `Bearer ${editorLogin.token}`
      }
      this.results.editorTests = await this.testPermissions(editorHeaders, 'editor', 'Editor')
    } else {
      this.results.editorTests.failed = 1
      this.results.editorTests.errors.push('Editor login failed')
    }
    
    // Test Guest Access
    this.log('🔹 Testing Guest Access', 'info')
    this.results.guestTests = await this.testPermissions({}, 'guest', 'Guest')
    
    // Generate report
    this.generateReport()
  }

  generateReport() {
    this.log('=' * 60, 'info')
    this.log('🎾 ROLE-BASED AUTHENTICATION TEST RESULTS', 'info')
    this.log('=' * 60, 'info')
    
    const roles = [
      { name: 'Admin', results: this.results.adminTests },
      { name: 'Editor', results: this.results.editorTests }, 
      { name: 'Guest', results: this.results.guestTests }
    ]
    
    let totalPassed = 0
    let totalFailed = 0
    
    roles.forEach(role => {
      const { passed, failed, errors } = role.results
      totalPassed += passed
      totalFailed += failed
      
      this.log(`${role.name} Tests: ✅ ${passed} passed, ❌ ${failed} failed`, 
               failed === 0 ? 'success' : 'warning')
      
      if (errors.length > 0) {
        this.log(`  Errors:`, 'error')
        errors.forEach(error => this.log(`    - ${error}`, 'error'))
      }
    })
    
    this.log('=' * 60, 'info')
    this.log(`Overall: ✅ ${totalPassed} passed, ❌ ${totalFailed} failed`, 
             totalFailed === 0 ? 'success' : 'warning')
    
    if (totalFailed === 0) {
      this.log('🎉 All role-based authentication tests passed!', 'success')
      this.log('👑 Admin: Full access to all features', 'info')
      this.log('✏️  Editor: Can edit matches only', 'info')
      this.log('👤 Guest: View-only access', 'info')
    } else {
      this.log('🔧 Some tests failed. Check the configuration and permissions.', 'error')
    }
  }
}

// CLI interface
if (import.meta.url === `file://${process.argv[1]}`) {
  const tester = new RoleAuthTester()
  
  tester.runAllTests().catch(error => {
    console.error('❌ Test runner failed:', error.message)
    process.exit(1)
  })
}

export default RoleAuthTester