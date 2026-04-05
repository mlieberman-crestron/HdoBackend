const express = require('express');
const jwt = require('jsonwebtoken');
const router = express.Router();

// POST /auth/login
// Body: { passcode }
// Returns: { token }
router.post('/login', (req, res) => {
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
