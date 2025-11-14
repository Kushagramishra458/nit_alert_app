const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const admin = require('firebase-admin');

// Initialize Express
const app = express();
app.use(cors());
app.use(express.json());

// Initialize Firebase Admin
let db;
try {
  // Get service account credentials from environment variable
  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  
  if (!serviceAccountJson) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON environment variable is not set');
  }

  // Parse the JSON string
  const serviceAccount = JSON.parse(serviceAccountJson);

  // Initialize Firebase Admin
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });

  // Get Firestore database reference
  db = admin.firestore();
  console.log('Firebase Admin initialized successfully');
} catch (error) {
  console.error('Error initializing Firebase Admin:', error.message);
  process.exit(1);
}

// Environment variables for API keys
const ONESIGNAL_APP_ID = process.env.ONESIGNAL_APP_ID;
const ONESIGNAL_API_KEY = process.env.ONESIGNAL_API_KEY;
const BREVO_API_KEY = process.env.BREVO_API_KEY;
const BREVO_SENDER_EMAIL = process.env.BREVO_SENDER_EMAIL;
const BREVO_SENDER_NAME = process.env.BREVO_SENDER_NAME || 'NIT JSR Emergency Alert';

// POST route to process SOS alerts
app.post('/processSOS', async (req, res) => {
  try {
    // Get data from request body
    const { lat, lon, userId } = req.body;

    // Validate required fields
    if (!lat || !lon || !userId) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: lat, lon, and userId are required'
      });
    }

    console.log(`Processing SOS alert for user: ${userId} at location (${lat}, ${lon})`);

    // 1. Get student data from Firestore 'students' collection
    const studentDoc = await db.collection('students').doc(userId).get();

    if (!studentDoc.exists) {
      return res.status(404).json({
        success: false,
        error: `Student with userId ${userId} not found`
      });
    }

    const studentData = studentDoc.data();
    console.log('Student data retrieved:', {
      name: studentData.name,
      email: studentData.email,
      phone: studentData.phone
    });

    // 2. Save the new alert to the 'activeAlerts' collection
    const alertData = {
      userId: userId,
      studentName: studentData.name || 'Unknown',
      studentEmail: studentData.email || '',
      studentPhone: studentData.phone || '',
      latitude: lat,
      longitude: lon,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      status: 'active',
      resolved: false
    };

    const alertRef = await db.collection('activeAlerts').add(alertData);
    console.log('Alert saved to Firestore with ID:', alertRef.id);

    // 3. Send OneSignal push notification
    let pushNotificationSent = false;
    if (ONESIGNAL_APP_ID && ONESIGNAL_API_KEY) {
      try {
        const oneSignalUrl = 'https://onesignal.com/api/v1/notifications';
        const notificationPayload = {
          app_id: ONESIGNAL_APP_ID,
          included_segments: ['All'],
          headings: { en: '🚨 Emergency Alert' },
          contents: {
            en: `Emergency alert from ${studentData.name || userId} at location (${lat}, ${lon})`
          },
          data: {
            userId: userId,
            lat: lat,
            lon: lon,
            alertId: alertRef.id,
            studentName: studentData.name || 'Unknown'
          },
          priority: 10
        };

        const oneSignalResponse = await fetch(oneSignalUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Basic ${ONESIGNAL_API_KEY}`
          },
          body: JSON.stringify(notificationPayload)
        });

        if (oneSignalResponse.ok) {
          const oneSignalResult = await oneSignalResponse.json();
          console.log('OneSignal notification sent successfully:', oneSignalResult.id);
          pushNotificationSent = true;
        } else {
          const errorText = await oneSignalResponse.text();
          console.error('OneSignal notification failed:', errorText);
        }
      } catch (error) {
        console.error('Error sending OneSignal notification:', error.message);
      }
    } else {
      console.warn('OneSignal credentials not configured');
    }

    // 4. Send Brevo email
    let emailSent = false;
    if (BREVO_API_KEY && BREVO_SENDER_EMAIL) {
      try {
        // Get emergency contacts or use default
        const emergencyContacts = studentData.emergencyContacts || [];
        const recipientEmails = emergencyContacts.length > 0
          ? emergencyContacts.map(contact => contact.email).filter(Boolean)
          : [studentData.email].filter(Boolean);

        if (recipientEmails.length > 0) {
          const brevoUrl = 'https://api.brevo.com/v3/smtp/email';
          const emailPayload = {
            sender: {
              name: BREVO_SENDER_NAME,
              email: BREVO_SENDER_EMAIL
            },
            to: recipientEmails.map(email => ({ email })),
            subject: `🚨 Emergency Alert: ${studentData.name || userId}`,
            htmlContent: `
              <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                <h2 style="color: #e63946;">Emergency Alert</h2>
                <p><strong>Student Name:</strong> ${studentData.name || 'Unknown'}</p>
                <p><strong>Student ID:</strong> ${userId}</p>
                <p><strong>Location:</strong> Latitude: ${lat}, Longitude: ${lon}</p>
                <p><strong>Time:</strong> ${new Date().toLocaleString()}</p>
                <p><strong>Phone:</strong> ${studentData.phone || 'Not provided'}</p>
                <p style="margin-top: 20px;">
                  <a href="https://www.google.com/maps?q=${lat},${lon}" 
                     style="background-color: #e63946; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; display: inline-block;">
                    View Location on Map
                  </a>
                </p>
              </div>
            `,
            textContent: `
Emergency Alert

Student Name: ${studentData.name || 'Unknown'}
Student ID: ${userId}
Location: Latitude: ${lat}, Longitude: ${lon}
Time: ${new Date().toLocaleString()}
Phone: ${studentData.phone || 'Not provided'}

View location: https://www.google.com/maps?q=${lat},${lon}
            `
          };

          const brevoResponse = await fetch(brevoUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'api-key': BREVO_API_KEY
            },
            body: JSON.stringify(emailPayload)
          });

          if (brevoResponse.ok) {
            const brevoResult = await brevoResponse.json();
            console.log('Brevo email sent successfully:', brevoResult.messageId);
            emailSent = true;
          } else {
            const errorText = await brevoResponse.text();
            console.error('Brevo email failed:', errorText);
          }
        } else {
          console.warn('No recipient emails found for student');
        }
      } catch (error) {
        console.error('Error sending Brevo email:', error.message);
      }
    } else {
      console.warn('Brevo credentials not configured');
    }

    // Return success response
    res.status(200).json({
      success: true,
      message: 'SOS alert processed successfully',
      alertId: alertRef.id,
      notifications: {
        pushNotification: pushNotificationSent,
        email: emailSent
      }
    });

  } catch (error) {
    console.error('Error processing SOS alert:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error.message
    });
  }
});

// Health check route
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    message: 'Server is running',
    timestamp: new Date().toISOString()
  });
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});

