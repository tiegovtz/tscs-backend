# TSCS Backend API

Backend API for the TSCS (Teacher Submission Competition System) built with Node.js, Express, and MongoDB.

## Tech Stack

- **Node.js** - Runtime environment
- **Express.js** - Web framework
- **MongoDB** - Database (MongoDB Atlas)
- **Mongoose** - MongoDB object modeling
- **JWT** - Authentication
- **bcryptjs** - Password hashing
- **Easymail** - Primary transactional email API
- **Nodemailer/Brevo** - Optional delivery fallbacks
- **express-rate-limit** - Rate limiting

## Prerequisites

- Node.js (v14 or higher)
- npm (Node Package Manager)
- MongoDB Atlas account (or local MongoDB instance)

## Installation

1. Install dependencies:
```bash
npm install
```

2. Create a `.env` file in the root directory:
```bash
cp .env.example .env
```

3. Update the `.env` file with your configuration:
- MongoDB Atlas connection string
- JWT secret key
- Server port
- Client URL (frontend URL)

## Environment Variables

```env
PORT=5000
NODE_ENV=development
MONGODB_URI=mongodb+srv://username:password@cluster.mongodb.net/tscs?retryWrites=true&w=majority
JWT_SECRET=your-super-secret-jwt-key-change-this-in-production
CLIENT_URL=http://localhost:5173
EASYMAIL_API_URL=https://easymail-nu.vercel.app/api/v1/emails
EASYMAIL_API_KEY=gms_your_sender_bound_api_key
```

## Running the Server

### Development Mode (with auto-reload)
```bash
npm run dev
```

### Production Mode
```bash
npm start
```

The server will start on `http://localhost:5000` (or the port specified in `.env`).

## Round-Scoped Assignment Index Maintenance

If you encounter a duplicate key error such as `E11000 ... submissionassignments index: submissionId_1`, run the migration scripts below to align indexes with the round-scoped assignment model:

```bash
# 1) Inspect and reconcile submission-round/assignment integrity (dry run)
npm run migrate:submission-round-integrity

# 2) Apply integrity reconciliation changes
node scripts/migrateSubmissionRoundIntegrity.js --apply

# 3) Drop legacy indexes and sync schema indexes
npm run migrate:round-indexes
```

Expected `SubmissionAssignment` uniqueness after migration:
- Unique on `{ roundId: 1, submissionId: 1 }`
- No unique index on `{ submissionId: 1 }`

## API Endpoints

### Authentication
- `POST /api/auth/login` - Login user (requires verified email)
- `POST /api/auth/register` - Register new teacher (sends OTP)
- `POST /api/auth/verify-otp` - Verify email with OTP
- `POST /api/auth/resend-otp` - Resend verification OTP
- `GET /api/auth/me` - Get current user (Protected)

### Users
- `GET /api/users` - Get all users (Admin/Superadmin)
- `GET /api/users/:id` - Get user by ID (Admin/Superadmin)
- `POST /api/users` - Create user (Admin/Superadmin)
- `PUT /api/users/:id` - Update user (Admin/Superadmin)
- `DELETE /api/users/:id` - Delete user (Superadmin only)

### Submissions
- `GET /api/submissions` - Get all submissions (with filters)
- `GET /api/submissions/:id` - Get submission by ID
- `POST /api/submissions` - Create submission
- `PUT /api/submissions/:id` - Update submission
- `DELETE /api/submissions/:id` - Delete submission (Admin/Superadmin)

### Competitions
- `GET /api/competitions` - Get all competition years
- `GET /api/competitions/:year` - Get competition by year
- `POST /api/competitions` - Create competition (Superadmin)
- `PUT /api/competitions/:year` - Update competition (Superadmin)

### Evaluations
- `GET /api/evaluations` - Get all evaluations
- `GET /api/evaluations/:id` - Get evaluation by ID
- `POST /api/evaluations` - Create/update evaluation (Judge)
- `GET /api/evaluations/submission/:submissionId` - Get evaluations for a submission

### Quotas
- `GET /api/quotas` - Get all quotas (Superadmin)
- `GET /api/quotas/:year/:level` - Get quota by year and level (Superadmin)
- `POST /api/quotas` - Create/update quota (Superadmin)

### Tie-Breaking
- `GET /api/tie-breaking` - Get all tie-breaking rounds
- `GET /api/tie-breaking/:id` - Get tie-breaking round by ID
- `POST /api/tie-breaking` - Create tie-breaking round (Admin/Superadmin)
- `POST /api/tie-breaking/:id/vote` - Submit vote (Judge)

### System Logs
- `GET /api/system-logs` - Get system logs (Superadmin)
- `GET /api/system-logs/:id` - Get log by ID (Superadmin)
- `DELETE /api/system-logs` - Delete old logs (Superadmin)

### Landing Page
- `GET /api/landing-page` - Get all sections (Public/Admin)
- `GET /api/landing-page/:id` - Get section by ID (Admin/Superadmin)
- `POST /api/landing-page` - Create section (Admin/Superadmin)
- `PUT /api/landing-page/:id` - Update section (Admin/Superadmin)
- `DELETE /api/landing-page/:id` - Delete section (Admin/Superadmin)

## Authentication

Most endpoints require authentication using JWT tokens. Include the token in the Authorization header:

```
Authorization: Bearer <token>
```

### Email Verification

Teacher registration now requires email verification:

1. **Registration**: User registers with `emailVerified: false`
2. **OTP Generation**: System generates 6-digit OTP, hashes it, and sends via email
3. **Email Verification**: User enters OTP to verify email and activate account
4. **Login**: Only verified users can log in

**OTP Security Features**:
- 6-digit numeric codes
- Hashed storage (never plain text)
- 10-minute expiration
- Max 5 verification attempts per OTP
- Only one active OTP per email
- 60-second resend cooldown
- Max 5 resends per hour
- Rate limiting on endpoints

### Email Notifications

The backend sends email through the live Easymail HTTPS API. Keep
`EASYMAIL_API_KEY` on the backend only; never expose it through the frontend or
commit it to Git. The key must be bound to the TSCS sender in the TSCS Easymail
workspace. Direct SMTP and Brevo remain optional fallbacks when configured.

Test the integration locally with:

```bash
npm run email:test -- --to recipient@example.com
```

The system includes an event-driven notification system:

- **In-app notifications**: Stored in database with read/unread status
- **Email notifications**: Sent asynchronously through Easymail
- **Event types**: USER_REGISTERED, SYSTEM_NOTIFICATION, competition events, etc.
- **Templates**: Professional HTML templates for OTP verification and system notifications

## Role-Based Access Control

- **Teacher**: Can create and manage own submissions
- **Judge**: Can evaluate submissions assigned to them
- **Admin**: Can manage users, submissions, and competitions
- **Superadmin**: Full access to all resources

## Project Structure

```
tscs-backend/
├── config/          # Configuration files
├── middleware/      # Custom middleware (auth, logging)
├── models/          # Mongoose models
├── routes/          # API routes
├── server.js        # Entry point
├── .env             # Environment variables (not in git)
└── package.json     # Dependencies
```

## Development

- The server uses `nodemon` for auto-reload during development
- All requests are logged via the SystemLog model
- CORS is configured to allow requests from the frontend

## License

ISC
