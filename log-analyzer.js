#!/usr/bin/env node

// Simple log analysis utility for Tennis Ranking System
// Usage: node log-analyzer.js [options]

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { dirname } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const logsDir = path.join(__dirname, 'logs')
const accessLogFile = path.join(logsDir, 'access.log')

// Parse command line arguments
const args = process.argv.slice(2)
const options = {
  showIPs: args.includes('--ips') || args.includes('-i'),
  showUsers: args.includes('--users') || args.includes('-u'),
  showStats: args.includes('--stats') || args.includes('-s'),
  showRecent: args.includes('--recent') || args.includes('-r'),
  lines: parseInt(args.find(arg => arg.startsWith('--lines='))?.split('=')[1]) || 50,
  help: args.includes('--help') || args.includes('-h')
}

function showHelp() {
  console.log(`
Tennis Ranking System - Log Analyzer

Usage: node log-analyzer.js [options]

Options:
  -i, --ips      Show IP address analysis
  -u, --users    Show user activity analysis  
  -s, --stats    Show general statistics
  -r, --recent   Show recent requests (default: 50 lines)
  --lines=N      Number of recent lines to show (default: 50)
  -h, --help     Show this help message

Examples:
  node log-analyzer.js --recent         # Show last 50 requests
  node log-analyzer.js --ips           # Analyze IP addresses
  node log-analyzer.js --stats         # Show statistics
  node log-analyzer.js --lines=100     # Show last 100 requests
`)
}

function formatIP(ip, ipSources = {}) {
  if (!ip || ip === 'unknown') return 'Unknown IP'
  
  let formatted = ip
  
  // Add human-readable descriptions
  if (ip === '::1') formatted = `${ip} (localhost IPv6)`
  else if (ip === '127.0.0.1') formatted = `${ip} (localhost IPv4)`
  else if (ip.startsWith('192.168.')) formatted = `${ip} (private)`
  else if (ip.startsWith('10.')) formatted = `${ip} (private)`
  else if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) formatted = `${ip} (private)`
  else formatted = `${ip} (public)`
  
  // Show detection method if available
  if (ipSources) {
    const sources = []
    if (ipSources.cfConnectingIP) sources.push('Cloudflare')
    if (ipSources.xRealIP) sources.push('X-Real-IP')
    if (ipSources.xForwardedFor) sources.push('X-Forwarded-For')
    if (sources.length > 0) {
      formatted += ` [via ${sources.join(', ')}]`
    }
  }
  
  return formatted
}

function parseLogFile() {
  if (!fs.existsSync(accessLogFile)) {
    console.log('❌ Access log file not found:', accessLogFile)
    console.log('Make sure the server has been running and generating logs.')
    return []
  }
  
  try {
    const content = fs.readFileSync(accessLogFile, 'utf8')
    const lines = content.trim().split('\n').filter(line => line.trim())
    
    const entries = []
    for (const line of lines) {
      try {
        const entry = JSON.parse(line)
        entries.push(entry)
      } catch (error) {
        console.warn('⚠️ Failed to parse log line:', line.substring(0, 100) + '...')
      }
    }
    
    return entries
  } catch (error) {
    console.error('❌ Error reading log file:', error.message)
    return []
  }
}

function analyzeIPs(entries) {
  console.log('\n📊 IP Address Analysis\n' + '='.repeat(50))
  
  const ipStats = {}
  const ipDetails = {}
  
  entries.forEach(entry => {
    const ip = entry.clientIP || 'unknown'
    
    if (!ipStats[ip]) {
      ipStats[ip] = {
        count: 0,
        users: new Set(),
        paths: new Set(),
        statusCodes: {},
        firstSeen: entry.timestamp,
        lastSeen: entry.timestamp,
        userAgents: new Set()
      }
      ipDetails[ip] = {
        formatted: formatIP(ip, entry.ipDetectionSources),
        geo: entry.geo,
        sources: entry.ipDetectionSources
      }
    }
    
    const stats = ipStats[ip]
    stats.count++
    if (entry.user) stats.users.add(entry.user.username)
    stats.paths.add(entry.path)
    stats.statusCodes[entry.statusCode] = (stats.statusCodes[entry.statusCode] || 0) + 1
    stats.lastSeen = entry.timestamp
    if (entry.userAgent) stats.userAgents.add(entry.userAgent)
  })
  
  // Sort by request count
  const sortedIPs = Object.entries(ipStats).sort(([,a], [,b]) => b.count - a.count)
  
  console.log(`Found ${sortedIPs.length} unique IP addresses\n`)
  
  sortedIPs.slice(0, 10).forEach(([ip, stats], index) => {
    const details = ipDetails[ip]
    console.log(`${index + 1}. ${details.formatted}`)
    console.log(`   Requests: ${stats.count}`)
    console.log(`   Users: ${stats.users.size > 0 ? Array.from(stats.users).join(', ') : 'anonymous only'}`)
    console.log(`   Unique paths: ${stats.paths.size}`)
    console.log(`   Status codes: ${Object.entries(stats.statusCodes).map(([code, count]) => `${code}(${count})`).join(', ')}`)
    console.log(`   Period: ${new Date(stats.firstSeen).toLocaleString()} - ${new Date(stats.lastSeen).toLocaleString()}`)
    
    if (details.geo) {
      console.log(`   Location: ${details.geo.city}, ${details.geo.country}`)
    }
    
    if (details.sources && Object.values(details.sources).some(v => v)) {
      const activeSources = Object.entries(details.sources)
        .filter(([key, value]) => value)
        .map(([key, value]) => `${key}: ${value}`)
      console.log(`   IP Sources: ${activeSources.join(', ')}`)
    }
    
    console.log('')
  })
}

function analyzeUsers(entries) {
  console.log('\n👥 User Activity Analysis\n' + '='.repeat(50))
  
  const userStats = {}
  let anonymousRequests = 0
  
  entries.forEach(entry => {
    if (entry.user) {
      const username = entry.user.username
      if (!userStats[username]) {
        userStats[username] = {
          count: 0,
          role: entry.user.role,
          ips: new Set(),
          paths: new Set(),
          statusCodes: {},
          firstSeen: entry.timestamp,
          lastSeen: entry.timestamp
        }
      }
      
      const stats = userStats[username]
      stats.count++
      stats.ips.add(entry.clientIP)
      stats.paths.add(entry.path)
      stats.statusCodes[entry.statusCode] = (stats.statusCodes[entry.statusCode] || 0) + 1
      stats.lastSeen = entry.timestamp
    } else {
      anonymousRequests++
    }
  })
  
  console.log(`Anonymous requests: ${anonymousRequests}`)
  console.log(`Authenticated users: ${Object.keys(userStats).length}\n`)
  
  Object.entries(userStats).forEach(([username, stats]) => {
    console.log(`👤 ${username} (${stats.role})`)
    console.log(`   Requests: ${stats.count}`)
    console.log(`   IP addresses: ${Array.from(stats.ips).map(ip => formatIP(ip)).join(', ')}`)
    console.log(`   Unique paths: ${stats.paths.size}`)
    console.log(`   Status codes: ${Object.entries(stats.statusCodes).map(([code, count]) => `${code}(${count})`).join(', ')}`)
    console.log(`   Period: ${new Date(stats.firstSeen).toLocaleString()} - ${new Date(stats.lastSeen).toLocaleString()}`)
    console.log('')
  })
}

function showStatistics(entries) {
  console.log('\n📈 General Statistics\n' + '='.repeat(50))
  
  const stats = {
    totalRequests: entries.length,
    uniqueIPs: new Set(entries.map(e => e.clientIP)).size,
    authenticatedRequests: entries.filter(e => e.user).length,
    uniqueUsers: new Set(entries.filter(e => e.user).map(e => e.user.username)).size,
    statusCodes: {},
    methods: {},
    paths: {},
    browsers: {},
    os: {},
    countries: {}
  }
  
  entries.forEach(entry => {
    // Status codes
    stats.statusCodes[entry.statusCode] = (stats.statusCodes[entry.statusCode] || 0) + 1
    
    // HTTP methods
    stats.methods[entry.method] = (stats.methods[entry.method] || 0) + 1
    
    // Popular paths
    stats.paths[entry.path] = (stats.paths[entry.path] || 0) + 1
    
    // Browsers
    if (entry.browser?.name) {
      stats.browsers[entry.browser.name] = (stats.browsers[entry.browser.name] || 0) + 1
    }
    
    // Operating systems
    if (entry.os?.name) {
      stats.os[entry.os.name] = (stats.os[entry.os.name] || 0) + 1
    }
    
    // Countries
    if (entry.geo?.country) {
      stats.countries[entry.geo.country] = (stats.countries[entry.geo.country] || 0) + 1
    }
  })
  
  console.log(`Total requests: ${stats.totalRequests}`)
  console.log(`Unique IP addresses: ${stats.uniqueIPs}`)
  console.log(`Authenticated requests: ${stats.authenticatedRequests} (${(stats.authenticatedRequests/stats.totalRequests*100).toFixed(1)}%)`)
  console.log(`Unique users: ${stats.uniqueUsers}`)
  
  console.log('\nTop Status Codes:')
  Object.entries(stats.statusCodes)
    .sort(([,a], [,b]) => b - a)
    .slice(0, 5)
    .forEach(([code, count]) => {
      console.log(`  ${code}: ${count} (${(count/stats.totalRequests*100).toFixed(1)}%)`)
    })
  
  console.log('\nTop Paths:')
  Object.entries(stats.paths)
    .sort(([,a], [,b]) => b - a)
    .slice(0, 5)
    .forEach(([path, count]) => {
      console.log(`  ${path}: ${count}`)
    })
  
  if (Object.keys(stats.browsers).length > 0) {
    console.log('\nTop Browsers:')
    Object.entries(stats.browsers)
      .sort(([,a], [,b]) => b - a)
      .slice(0, 3)
      .forEach(([browser, count]) => {
        console.log(`  ${browser}: ${count}`)
      })
  }
  
  if (Object.keys(stats.countries).length > 0) {
    console.log('\nTop Countries:')
    Object.entries(stats.countries)
      .sort(([,a], [,b]) => b - a)
      .slice(0, 5)
      .forEach(([country, count]) => {
        console.log(`  ${country}: ${count}`)
      })
  }
}

function showRecentRequests(entries, lines) {
  console.log(`\n📋 Recent Requests (last ${lines})\n` + '='.repeat(50))
  
  const recent = entries.slice(-lines).reverse()
  
  recent.forEach((entry, index) => {
    const timestamp = new Date(entry.timestamp).toLocaleString()
    const userInfo = entry.user ? `${entry.user.username}(${entry.user.role})` : 'anonymous'
    const ipInfo = formatIP(entry.clientIP, entry.ipDetectionSources)
    const statusIcon = entry.statusCode >= 400 ? '❌' : entry.statusCode >= 300 ? '⚠️' : '✅'
    
    console.log(`${statusIcon} ${timestamp} | ${entry.method} ${entry.path} | ${ipInfo} | ${userInfo} | ${entry.statusCode} | ${entry.responseTime}ms`)
  })
}

// Main execution
async function main() {
  if (options.help) {
    showHelp()
    return
  }
  
  console.log('🎾 Tennis Ranking System - Log Analyzer')
  console.log('=========================================')
  
  const entries = parseLogFile()
  
  if (entries.length === 0) {
    console.log('\n❌ No log entries found. Make sure the server is running and has processed some requests.')
    return
  }
  
  console.log(`\n📊 Loaded ${entries.length} log entries from ${accessLogFile}`)
  
  if (options.showStats || (!options.showIPs && !options.showUsers && !options.showRecent)) {
    showStatistics(entries)
  }
  
  if (options.showIPs) {
    analyzeIPs(entries)
  }
  
  if (options.showUsers) {
    analyzeUsers(entries)
  }
  
  if (options.showRecent) {
    showRecentRequests(entries, options.lines)
  }
}

main().catch(console.error)