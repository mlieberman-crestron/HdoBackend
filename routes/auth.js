const express = require('express');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const router = express.Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Try again in 15 minutes.' },
});

router.post('/login', loginLimiter, (req, res) => {
  const { passcode } = req.body;
  if (!passcode) {
    return res.status(400).json({ error: 'Passcode is required' });
  }
  if (passcode !== process.env.APP_PASSCODE) {
    return res.status(401).json({ error: 'Invalid passcode' });
  }
  const token = jwt.sign(
    { authenticated: true },
    process.env.JWT_SECRET,
    { expiresIn: '90d' }
  );
  res.json({ token });
});

module.exports = router;