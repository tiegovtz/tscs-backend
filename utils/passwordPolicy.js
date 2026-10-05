const PASSWORD_REQUIREMENTS = [
  { test: (password) => password.length >= 8, message: 'Password must be at least 8 characters long' },
  { test: (password) => /[a-z]/.test(password), message: 'Password must contain at least one lowercase letter' },
  { test: (password) => /[A-Z]/.test(password), message: 'Password must contain at least one uppercase letter' },
  { test: (password) => /\d/.test(password), message: 'Password must contain at least one number' },
  { test: (password) => /[^A-Za-z0-9]/.test(password), message: 'Password must contain at least one special character' }
];

function validatePassword(password) {
  if (typeof password !== 'string') {
    return { valid: false, message: 'Password is required' };
  }

  const failedRequirement = PASSWORD_REQUIREMENTS.find(({ test }) => !test(password));
  return failedRequirement
    ? { valid: false, message: failedRequirement.message }
    : { valid: true };
}

module.exports = { validatePassword };
