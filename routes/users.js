import { Router } from 'express'
import { body, param } from 'express-validator'
import bcrypt from 'bcrypt'
import { asyncHandler } from '../utils/async-handler.js'

export const createAuthRouter = ({
  db,
  authenticateToken,
  requireAdmin,
  handleValidationErrors,
  conditionalRateLimit,
  createLimiter
}) => {
  const router = Router()
  const SALT_ROUNDS = 12

  // Get all users (admin only)
  router.get(
    '/users',
    authenticateToken,
    requireAdmin,
    asyncHandler(async (req, res) => {
      const users = await db.getUsers()
      // Remove password_hash from response
      const safeUsers = users.map(({ password_hash, ...user }) => user)
      res.json(safeUsers)
    })
  )

  // Get single user (admin only)
  router.get(
    '/users/:id',
    authenticateToken,
    requireAdmin,
    [param('id').isInt().withMessage('Invalid user ID')],
    handleValidationErrors,
    asyncHandler(async (req, res) => {
      const userId = parseInt(req.params.id)
      const user = await db.getUserById(userId)
      if (!user) {
        return res.status(404).json({ error: 'User not found' })
      }
      // Remove password_hash from response
      const { password_hash, ...safeUser } = user
      res.json(safeUser)
    })
  )

  // Create new user (admin only)
  router.post(
    '/users',
    authenticateToken,
    requireAdmin,
    conditionalRateLimit(createLimiter),
    [
      body('username')
        .trim()
        .isLength({ min: 3, max: 50 })
        .withMessage('Username must be 3-50 characters')
        .matches(/^[a-zA-Z0-9_]+$/)
        .withMessage('Username can only contain letters, numbers, and underscores'),
      body('password')
        .isLength({ min: 6 })
        .withMessage('Password must be at least 6 characters'),
      body('email')
        .optional({ nullable: true, checkFalsy: true })
        .isEmail()
        .withMessage('Invalid email format'),
      body('role')
        .isIn(['admin', 'editor', 'viewer'])
        .withMessage('Role must be admin, editor, or viewer'),
      body('displayName')
        .optional()
        .trim()
        .isLength({ max: 100 })
        .withMessage('Display name must be under 100 characters'),
      body('notes')
        .optional()
        .trim()
    ],
    handleValidationErrors,
    asyncHandler(async (req, res) => {
      const { username, password, email, role, displayName, notes } = req.body
      
      // Check if username exists
      const usernameExists = await db.checkUsernameExists(username)
      if (usernameExists) {
        return res.status(400).json({ error: 'Username already exists' })
      }
      
      // Check if email exists (if provided)
      if (email) {
        const emailExists = await db.checkEmailExists(email)
        if (emailExists) {
          return res.status(400).json({ error: 'Email already exists' })
        }
      }
      
      // Hash password
      const passwordHash = await bcrypt.hash(password, SALT_ROUNDS)
      
      // Create user
      const createdBy = req.user?.username || 'system'
      const user = await db.createUser(
        username,
        email || null,
        passwordHash,
        role,
        displayName || username,
        createdBy,
        notes || null
      )
      
      res.status(201).json({
        success: true,
        message: 'User created successfully',
        user
      })
    })
  )

  // Update user (admin only)
  router.put(
    '/users/:id',
    authenticateToken,
    requireAdmin,
    [
      param('id').isInt().withMessage('Invalid user ID'),
      body('email')
        .optional({ nullable: true, checkFalsy: true })
        .isEmail()
        .withMessage('Invalid email format'),
      body('role')
        .optional()
        .isIn(['admin', 'editor', 'viewer'])
        .withMessage('Role must be admin, editor, or viewer'),
      body('displayName')
        .optional()
        .trim()
        .isLength({ max: 100 }),
      body('isActive')
        .optional()
        .isBoolean(),
      body('notes')
        .optional()
        .trim()
    ],
    handleValidationErrors,
    asyncHandler(async (req, res) => {
      const userId = parseInt(req.params.id)
      const { email, role, displayName, isActive, notes } = req.body
      
      // Check if user exists
      const existingUser = await db.getUserById(userId)
      if (!existingUser) {
        return res.status(404).json({ error: 'User not found' })
      }
      
      // Check if email is taken by another user
      if (email) {
        const emailExists = await db.checkEmailExists(email, userId)
        if (emailExists) {
          return res.status(400).json({ error: 'Email already in use by another user' })
        }
      }
      
      const updatedUser = await db.updateUser(userId, {
        email,
        role,
        displayName,
        isActive,
        notes
      })
      
      res.json({
        success: true,
        message: 'User updated successfully',
        user: updatedUser
      })
    })
  )

  // Change user password (admin only)
  router.put(
    '/users/:id/password',
    authenticateToken,
    requireAdmin,
    [
      param('id').isInt().withMessage('Invalid user ID'),
      body('password')
        .isLength({ min: 6 })
        .withMessage('Password must be at least 6 characters')
    ],
    handleValidationErrors,
    asyncHandler(async (req, res) => {
      const userId = parseInt(req.params.id)
      const { password } = req.body
      
      const existingUser = await db.getUserById(userId)
      if (!existingUser) {
        return res.status(404).json({ error: 'User not found' })
      }
      
      const passwordHash = await bcrypt.hash(password, SALT_ROUNDS)
      await db.updateUserPassword(userId, passwordHash)
      
      res.json({
        success: true,
        message: 'Password updated successfully'
      })
    })
  )

  // Delete user (admin only)
  router.delete(
    '/users/:id',
    authenticateToken,
    requireAdmin,
    [param('id').isInt().withMessage('Invalid user ID')],
    handleValidationErrors,
    asyncHandler(async (req, res) => {
      const userId = parseInt(req.params.id)
      
      const existingUser = await db.getUserById(userId)
      if (!existingUser) {
        return res.status(404).json({ error: 'User not found' })
      }
      
      await db.deleteUser(userId)
      
      res.json({
        success: true,
        message: 'User deleted successfully'
      })
    })
  )

  return router
}
