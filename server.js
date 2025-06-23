import express from 'express'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import fs from 'fs/promises'
import cors from 'cors'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const app = express()
const PORT = process.env.PORT || 3001
const DATA_DIR = join(__dirname, 'data')

// Middleware
app.use(cors())
app.use(express.json({ limit: '10mb' }))
app.use(express.static('dist')) // Serve built files

// Ensure data directory exists
try {
  await fs.access(DATA_DIR)
} catch {
  await fs.mkdir(DATA_DIR, { recursive: true })
}

// API Routes

// Get list of Excel files
app.get('/api/files', async (req, res) => {
  try {
    const files = await fs.readdir(DATA_DIR)
    const excelFiles = files
      .filter(file => file.endsWith('.xlsx'))
      .map(file => {
        return {
          name: file,
          path: join(DATA_DIR, file)
        }
      })
    
    // Get file stats for each file
    const filesWithStats = await Promise.all(
      excelFiles.map(async (file) => {
        try {
          const stats = await fs.stat(file.path)
          return {
            name: file.name,
            size: stats.size,
            modified: stats.mtime,
            created: stats.birthtime
          }
        } catch (error) {
          return {
            name: file.name,
            size: 0,
            modified: new Date(),
            created: new Date(),
            error: 'Could not read file stats'
          }
        }
      })
    )

    res.json(filesWithStats.sort((a, b) => b.modified - a.modified))
  } catch (error) {
    console.error('Error reading data directory:', error)
    res.status(500).json({ error: 'Failed to read data files' })
  }
})

// Save Excel file to data folder
app.post('/api/save-excel', async (req, res) => {
  try {
    const { fileName, data } = req.body
    
    if (!fileName || !data) {
      return res.status(400).json({ error: 'Missing fileName or data' })
    }

    // Ensure filename is safe and has .xlsx extension
    const safeFileName = fileName.replace(/[^a-zA-Z0-9\-_\.]/g, '_')
    const fullFileName = safeFileName.endsWith('.xlsx') ? safeFileName : `${safeFileName}.xlsx`
    const filePath = join(DATA_DIR, fullFileName)

    // Convert base64 data to buffer and save
    const buffer = Buffer.from(data, 'base64')
    await fs.writeFile(filePath, buffer)

    res.json({ 
      success: true, 
      message: `File saved to ${fullFileName}`,
      fileName: fullFileName,
      path: filePath,
      size: buffer.length
    })
  } catch (error) {
    console.error('Error saving Excel file:', error)
    res.status(500).json({ error: 'Failed to save Excel file' })
  }
})

// Load Excel file from data folder
app.get('/api/load-excel/:fileName', async (req, res) => {
  try {
    const { fileName } = req.params
    const filePath = join(DATA_DIR, fileName)

    // Check if file exists
    try {
      await fs.access(filePath)
    } catch {
      return res.status(404).json({ error: 'File not found' })
    }

    // Read and return file as base64
    const buffer = await fs.readFile(filePath)
    const base64Data = buffer.toString('base64')

    res.json({
      success: true,
      fileName,
      data: base64Data,
      size: buffer.length
    })
  } catch (error) {
    console.error('Error loading Excel file:', error)
    res.status(500).json({ error: 'Failed to load Excel file' })
  }
})

// Delete Excel file
app.delete('/api/delete-excel/:fileName', async (req, res) => {
  try {
    const { fileName } = req.params
    const filePath = join(DATA_DIR, fileName)

    // Check if file exists
    try {
      await fs.access(filePath)
    } catch {
      return res.status(404).json({ error: 'File not found' })
    }

    await fs.unlink(filePath)
    res.json({ success: true, message: `File ${fileName} deleted successfully` })
  } catch (error) {
    console.error('Error deleting Excel file:', error)
    res.status(500).json({ error: 'Failed to delete Excel file' })
  }
})

// Get current data file (latest or specified)
app.get('/api/current-data/:fileName?', async (req, res) => {
  try {
    let fileName = req.params.fileName

    if (!fileName) {
      // Get the most recent Excel file
      const files = await fs.readdir(DATA_DIR)
      const excelFiles = files.filter(file => file.endsWith('.xlsx'))
      
      if (excelFiles.length === 0) {
        return res.json({ success: false, message: 'No data files found' })
      }

      // Get the most recently modified file
      const filesWithStats = await Promise.all(
        excelFiles.map(async (file) => {
          const stats = await fs.stat(join(DATA_DIR, file))
          return { name: file, modified: stats.mtime }
        })
      )
      
      fileName = filesWithStats.sort((a, b) => b.modified - a.modified)[0].name
    }

    const filePath = join(DATA_DIR, fileName)
    const buffer = await fs.readFile(filePath)
    const base64Data = buffer.toString('base64')

    res.json({
      success: true,
      fileName,
      data: base64Data,
      size: buffer.length
    })
  } catch (error) {
    console.error('Error getting current data:', error)
    res.status(500).json({ error: 'Failed to get current data' })
  }
})

// Serve the application
app.get('*', (req, res) => {
  res.sendFile(join(__dirname, 'dist', 'index.html'))
})

app.listen(PORT, () => {
  console.log(`🎾 Tennis Ranking System Server running on http://localhost:${PORT}`)
  console.log(`📁 Data files stored in: ${DATA_DIR}`)
})
