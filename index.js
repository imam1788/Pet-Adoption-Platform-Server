require("dotenv").config();
const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const Stripe = require('stripe');
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");

const app = express();
const port = process.env.PORT || 5000;


// Middleware
app.use(cors());
app.use(express.json());

// Stripe setup
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// PaymentIntent route
app.post('/create-payment-intent', async (req, res) => {
  const { amount } = req.body;

  if (!amount) {
    return res.status(400).send({ error: 'Amount is required' });
  }

  try {
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100), // Stripe uses cents
      currency: 'usd',
      payment_method_types: ['card'],
    });

    res.send({ clientSecret: paymentIntent.client_secret });
  } catch (error) {
    res.status(500).send({ error: error.message });
  }
});

// MongoDB Client Setup
const uri = process.env.MONGO_URI;
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    await client.connect();
    console.log("Connected to MongoDB");

    const db = client.db("pethaven");
    const usersCollection = db.collection("users");
    const petsCollection = db.collection("pets");
    const adoptionsCollection = db.collection("adoptions");
    const donationCampaignsCollection = db.collection("donationCampaigns");
    const donationsCollection = db.collection("donations");

    // Verify JWT Middleware
    function verifyToken(req, res, next) {
      const authHeader = req.headers.authorization;
      if (!authHeader) {
        return res.status(401).send({ error: "Unauthorized access" });
      }

      const token = authHeader.split(" ")[1];
      jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
        if (err) {
          return res.status(403).send({ error: "Forbidden access" });
        }

        req.user = decoded;
        next();
      });
    }


    // Admin role verification middleware
    async function verifyAdmin(req, res, next) {
      const authHeader = req.headers.authorization;
      if (!authHeader) {
        return res.status(401).send({ error: "Unauthorized access, no token" });
      }

      const token = authHeader.split(" ")[1];
      jwt.verify(token, process.env.JWT_SECRET, async (err, decoded) => {
        if (err) {
          return res.status(403).send({ error: "Forbidden access, invalid token" });
        }

        const email = decoded.email;

        const user = await usersCollection.findOne({ email });

        if (!user || user.role !== "admin") {
          return res.status(403).send({ error: "Admin access required" });
        }

        req.user = decoded;
        next();
      });
    }

    // Home route
    app.get("/", (req, res) => {
      res.send("Pet Haven Server is running...");
    });

    // Save user to DB

    app.post("/users", async (req, res) => {
      const user = req.body;

      if (!user.email) {
        return res.status(400).send({ error: "Email is required" });
      }

      const existingUser = await usersCollection.findOne({ email: user.email });
      if (existingUser) {
        return res.send({ message: "User already exists" });
      }

      user.role = "user";

      // Ensure photoURL is saved as well
      const result = await usersCollection.insertOne(user);
      res.send(result);
    });

    // GET user by email
    app.get("/users/:email", verifyToken, async (req, res) => {
      const email = req.params.email;
      const user = await usersCollection.findOne({ email });
      res.send(user);
    });

    // Get all users - Admin only route example
    app.get("/users", verifyAdmin, async (req, res) => {
      try {
        const users = await usersCollection.find().toArray();
        res.send(users);
      } catch (error) {
        res.status(500).send({ error: "Failed to fetch users" });
      }
    });

    // Make user admin (Admin only)
    app.patch('/users/make-admin/:id', verifyAdmin, async (req, res) => {
      try {
        const userId = req.params.id;

        const result = await usersCollection.updateOne(
          { _id: new ObjectId(userId) },
          { $set: { role: 'admin' } }
        );

        if (result.matchedCount === 0) {
          return res.status(404).send({ error: 'User not found' });
        }

        res.send({ success: true, message: 'User is now admin' });
      } catch (error) {
        res.status(500).send({ error: 'Failed to update user role' });
      }
    });

    // Ban user (Admin only)
    app.patch('/users/ban/:id', verifyAdmin, async (req, res) => {
      try {
        const userId = req.params.id;

        const result = await usersCollection.updateOne(
          { _id: new ObjectId(userId) },
          { $set: { banned: true } }
        );

        if (result.matchedCount === 0) {
          return res.status(404).send({ error: 'User not found' });
        }

        res.send({ success: true, modifiedCount: result.modifiedCount });
      } catch (error) {
        res.status(500).send({ error: 'Failed to ban user' });
      }
    });


    // Create JWT Token
    app.post("/jwt", async (req, res) => {
      const { email } = req.body;

      const user = await usersCollection.findOne({ email });

      if (!user) {
        return res.status(401).send({ message: "Unauthorized" });
      }

      // Block banned users
      if (user.banned) {
        return res.status(403).send({ message: "User is banned" });
      }

      // Issue token if not banned
      const token = jwt.sign({ email }, process.env.JWT_SECRET, {
        expiresIn: "7d",
      });

      res.send({ token });
    });



    app.get("/protected", verifyToken, (req, res) => {
      res.send({
        message: "This is protected data",
        user: req.user,
      });
    });

    // Route to save a new pet
    app.post("/pets", async (req, res) => {
      const pet = {
        ...req.body,
        adopted: false,
        date: new Date(),
      };

      try {
        const result = await petsCollection.insertOne(pet);
        res.send(result);
      } catch (err) {
        res.status(500).send({ error: "Failed to save pet" });
      }
    });



    // GET /pets?search=cat&category=Cat&page=1&limit=10
    app.get("/pets", verifyToken, async (req, res) => {
      try {
        const { search = "", category, page = 1, limit = 30 } = req.query;

        const query = {
          adopted: false,
          name: { $regex: search, $options: "i" },
        };

        if (category && category !== "All") {
          query.category = category;
        }

        const skip = (parseInt(page) - 1) * parseInt(limit);
        const pets = await petsCollection
          .find(query)
          .sort({ date: -1 })
          .skip(skip)
          .limit(parseInt(limit))
          .toArray();

        const total = await petsCollection.countDocuments(query);

        res.send({ pets, total });
      } catch (error) {
        res.status(500).send({ error: "Failed to fetch pets" });
      }
    });

    app.get("/pets/:id", async (req, res) => {
      try {
        const { id } = req.params;
        const pet = await petsCollection.findOne({ _id: new ObjectId(id) });
        if (!pet) return res.status(404).send({ error: "Pet not found" });
        res.send(pet);
      } catch (error) {
        res.status(500).send({ error: "Error fetching pet" });
      }
    });

    // Admin gets all pets
    app.get('/admin/pets', verifyToken, verifyAdmin, async (req, res) => {
      const pets = await petsCollection.find().toArray();
      res.send({ pets });
    });


    // Delete pet
    app.delete('/pets/:id', verifyToken, verifyAdmin, async (req, res) => {
      const id = req.params.id;
      const result = await petsCollection.deleteOne({ _id: new ObjectId(id) });
      res.send(result);
    });

    // Toggle adoption status
    app.patch('/pets/status/:id', verifyToken, verifyAdmin, async (req, res) => {
      const id = req.params.id;
      const { adopted } = req.body;
      const result = await petsCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { adopted } }
      );
      res.send(result);
    });


    app.post("/adoptions", async (req, res) => {
      try {
        const adoption = req.body;
        const result = await adoptionsCollection.insertOne(adoption);
        res.send(result);
      } catch (error) {
        res.status(500).send({ error: "Failed to submit adoption request" });
      }
    });

    // Get adoption requests for pets added by the logged-in user
    app.get('/adoptions/my-requests', verifyToken, async (req, res) => {
      try {
        const ownerEmail = req.user.email;

        // Find all pet IDs owned by this user
        const userPets = await petsCollection.find({ ownerEmail }).project({ _id: 1 }).toArray();
        const petIds = userPets.map(pet => pet._id);

        // Find adoption requests where petId in petIds
        const stringPetIds = petIds.map(id => id.toString());

        const adoptionRequests = await adoptionsCollection
          .find({ petId: { $in: stringPetIds } })
          .toArray();
        res.send(adoptionRequests);
      } catch (error) {
        console.error('Error fetching adoption requests:', error);
        res.status(500).send({ error: 'Failed to fetch adoption requests' });
      }
    });

    // Update adoption request status (Accept / Reject)
    app.patch('/adoptions/:id/status', verifyToken, async (req, res) => {
      try {
        const { id } = req.params;
        const { status } = req.body;

        if (!['accepted', 'rejected'].includes(status)) {
          return res.status(400).send({ error: 'Invalid status value' });
        }

        const result = await adoptionsCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { status } }
        );

        if (result.matchedCount === 0) {
          return res.status(404).send({ error: 'Adoption request not found' });
        }

        res.send({ success: true, message: `Adoption request ${status}` });
      } catch (error) {
        console.error('Error updating adoption request status:', error);
        res.status(500).send({ error: 'Failed to update adoption status' });
      }
    });



    // Get all pets added by a specific user with pagination
    app.get("/my-pets", verifyToken, async (req, res) => {
      try {
        const email = req.query.email;
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const skip = (page - 1) * limit;

        if (!email) {
          return res.status(400).send({ error: "Email is required" });
        }

        const query = { ownerEmail: email }; // Adjust field if you're using different one
        const total = await petsCollection.countDocuments(query);

        const pets = await petsCollection
          .find(query)
          .sort({ date: -1 })
          .skip(skip)
          .limit(limit)
          .toArray();

        res.send({
          pets,
          total,
          page,
          totalPages: Math.ceil(total / limit),
        });
      } catch (error) {
        res.status(500).send({ error: "Failed to fetch user pets" });
      }
    });

    // Mark pet as adopted
    app.patch("/pets/adopt/:id", verifyToken, async (req, res) => {
      const { id } = req.params;

      try {
        const result = await petsCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { adopted: true } }
        );

        if (result.matchedCount === 0) {
          return res.status(404).send({ error: "Pet not found" });
        }

        res.send({ success: true, message: "Pet marked as adopted" });
      } catch (error) {
        res.status(500).send({ error: "Failed to update pet status" });
      }
    });


    app.patch('/pets/:id', verifyToken, async (req, res) => {
      try {
        const petId = req.params.id;
        const updatedPetData = req.body;

        const result = await petsCollection.updateOne(
          { _id: new ObjectId(petId) },
          { $set: updatedPetData }
        );

        if (result.matchedCount === 0) {
          return res.status(404).send({ error: "Pet not found" });
        }

        res.send({ success: true, message: "Pet updated successfully" });
      } catch (error) {
        console.error("Error updating pet:", error);
        res.status(500).send({ error: "Failed to update pet" });
      }
    });

    // Delete a pet by ID
    app.delete("/pets/:id", verifyToken, async (req, res) => {
      const { id } = req.params;

      try {
        const result = await petsCollection.deleteOne({ _id: new ObjectId(id) });

        if (result.deletedCount === 0) {
          return res.status(404).send({ error: "Pet not found" });
        }

        res.send({ success: true, message: "Pet deleted successfully" });
      } catch (error) {
        res.status(500).send({ error: "Failed to delete pet" });
      }
    });


    // Create a new donation campaign
    app.post('/donation-campaigns', verifyToken, async (req, res) => {
      try {
        console.log('Incoming donation campaign:', req.body);

        const {
          petName,
          petImage,
          targetAmount,
          lastDate,
          description,
          longDesc,
          ownerEmail,
        } = req.body;

        if (
          !petName ||
          !petImage ||
          !targetAmount ||
          !lastDate ||
          !description ||
          !longDesc ||
          !ownerEmail
        ) {
          return res.status(400).send({ error: 'All fields are required' });
        }

        const campaign = {
          petName,
          petImage,
          targetAmount: Number(targetAmount),
          lastDate: new Date(lastDate),
          description,
          longDesc,
          ownerEmail,
          donatedAmount: 0,
          date: new Date(),
        };

        console.log('Inserting campaign:', campaign);

        const result = await donationCampaignsCollection.insertOne(campaign);

        res.send(result);
      } catch (error) {
        console.error('Server error on /donation-campaigns:', error);
        res.status(500).send({ error: 'Failed to create donation campaign' });
      }
    });

    // Get logged-in user's donation campaigns
    app.get("/donation-campaigns/my", verifyToken, async (req, res) => {
      try {
        console.log("User email from token:", req.user.email);
        const campaigns = await donationCampaignsCollection.find({ ownerEmail: req.user.email }).toArray();
        console.log("Found campaigns count:", campaigns.length);
        res.send({ campaigns });
      } catch (error) {
        console.error("Error fetching user campaigns:", error);
        res.status(500).send({ error: "Failed to fetch campaigns" });
      }
    });



    // Pause/unpause a donation campaign
    app.patch("/donation-campaigns/pause/:id", verifyToken, async (req, res) => {
      try {
        const id = req.params.id;
        const { paused } = req.body;

        const result = await donationCampaignsCollection.updateOne(
          { _id: new ObjectId(id), ownerEmail: req.user.email },
          { $set: { paused: !!paused } }
        );

        if (result.matchedCount === 0) {
          return res.status(404).send({ error: "Campaign not found or unauthorized" });
        }

        res.send({ success: true, paused: !!paused });
      } catch (error) {
        console.error("Error updating pause status:", error);
        res.status(500).send({ error: "Failed to update pause status" });
      }
    });

    // Get donators for a specific donation campaign
    app.get("/donations", verifyToken, async (req, res) => {
      try {
        const donationId = req.query.donationId;
        if (!donationId) {
          return res.status(400).send({ error: "donationId query param required" });
        }

        const donations = await donationsCollection
          .find({ donationId: new ObjectId(donationId) })
          .toArray();

        res.send({ donations });
      } catch (error) {
        console.error("Error fetching donations:", error);
        res.status(500).send({ error: "Failed to fetch donations" });
      }
    });



    // for editing specific donation campaign
    app.patch('/donation-campaigns/:id', verifyToken, async (req, res) => {
      const { id } = req.params;
      const updateData = req.body;

      try {
        // Optionally verify user permission here before updating

        const result = await donationCampaignsCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: updateData }
        );

        if (result.modifiedCount === 1) {
          res.json({ success: true });
        } else {
          res.status(404).json({ error: 'Donation campaign not found' });
        }
      } catch (error) {
        console.error('Update error:', error);
        res.status(500).json({ error: 'Server error' });
      }
    });

    // GET /donation-campaigns?page=1&limit=10
    app.get("/donation-campaigns", async (req, res) => {
      try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const skip = (page - 1) * limit;

        const campaigns = await donationCampaignsCollection
          .find({})
          .sort({ date: -1 })
          .skip(skip)
          .limit(limit)
          .toArray();

        const total = await donationCampaignsCollection.countDocuments();

        res.send({
          campaigns,
          total,
          page,
          totalPages: Math.ceil(total / limit),
        });
      } catch (error) {
        console.error("Error fetching donation campaigns:", error);
        res.status(500).send({ error: "Failed to fetch donation campaigns" });
      }
    });

    // GET single donation campaign by ID
    app.get("/donation-campaigns/:id", async (req, res) => {
      const { id } = req.params;
      const campaign = await donationCampaignsCollection.findOne({ _id: new ObjectId(id) });

      if (!campaign) {
        return res.status(404).send({ error: "Campaign not found" });
      }

      res.send(campaign);
    });

    // Get all donation campaigns (admin-only)
    app.get("/admin/all-donations", verifyToken, verifyAdmin, async (req, res) => {
      const campaigns = await donationCampaignsCollection
        .find({
          paused: { $in: [true, false] },
          ownerEmail: { $exists: true },
        })
        .toArray();
      res.send(campaigns);
    });

    // Toggle pause/unpause
    app.patch("/admin/campaigns/toggle-pause/:id", verifyToken, verifyAdmin, async (req, res) => {
      const { id } = req.params;
      const { paused } = req.body;
      const result = await donationCampaignsCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { paused } }
      );
      res.send(result);
    });

    // Delete campaign
    app.delete("/admin/campaigns/:id", verifyToken, verifyAdmin, async (req, res) => {
      const { id } = req.params;
      const result = await donationCampaignsCollection.deleteOne({ _id: new ObjectId(id) });
      res.send(result);
    });



    // for recommended campaigns
    app.get('/recommended-campaigns/:currentId', async (req, res) => {
      const currentId = req.params.currentId;

      const recommended = await donationCampaignsCollection
        .find({ _id: { $ne: new ObjectId(currentId) } })
        .sort({ date: -1 })
        .limit(3)
        .toArray();

      res.send(recommended);
    });


    app.post("/donations", verifyToken, async (req, res) => {
      const {
        donationId,
        amount,
        transactionId,
        date,
        status = "succeeded"
      } = req.body;

      const userEmail = req.user.email;

      if (!donationId || !amount || !transactionId) {
        return res.status(400).send({ error: "Missing donation details" });
      }

      try {
        // Check if campaign exists and if paused
        const campaign = await donationCampaignsCollection.findOne({ _id: new ObjectId(donationId) });
        if (!campaign) {
          return res.status(404).send({ error: "Donation campaign not found" });
        }

        if (campaign.paused) {
          return res.status(403).send({ error: "Donations are currently paused for this campaign" });
        }

        const donationDoc = {
          donationId: new ObjectId(donationId),
          amount,
          transactionId,
          donorEmail: userEmail,
          date: new Date(date),
          status,
        };

        const result = await donationsCollection.insertOne(donationDoc);

        await donationCampaignsCollection.updateOne(
          { _id: new ObjectId(donationId) },
          { $inc: { donatedAmount: amount } }
        );

        res.send({ success: true, insertedId: result.insertedId });
      } catch (error) {
        res.status(500).send({ error: error.message });
      }
    });

    app.get('/donations/my', verifyToken, async (req, res) => {
      try {
        const userEmail = req.user.email;

        const donations = await donationsCollection.find({ donorEmail: userEmail }).toArray();

        const campaignIds = donations.map(d => d.donationId);
        const campaigns = await donationCampaignsCollection
          .find({ _id: { $in: campaignIds } })
          .toArray();

        const donationsWithCampaign = donations.map(donation => {
          const campaign = campaigns.find(c => c._id.equals(donation.donationId));
          return {
            _id: donation._id,
            amount: donation.amount,
            donorEmail: donation.donorEmail,
            date: donation.date,
            transactionId: donation.transactionId,
            status: donation.status,
            petName: campaign?.petName || 'Unknown',
            petImage: campaign?.petImage || '',
          };
        });

        res.send(donationsWithCampaign);
      } catch (error) {
        console.error('Error fetching user donations:', error);
        res.status(500).send({ error: 'Failed to fetch donations' });
      }
    });

    app.delete('/donations/:donationId', verifyToken, async (req, res) => {
      const { donationId } = req.params;
      const userEmail = req.user.email;

      try {
        const donation = await donationsCollection.findOne({
          _id: new ObjectId(donationId),
          donorEmail: userEmail,
        });

        if (!donation) {
          return res.status(404).send({ error: 'Donation not found or unauthorized' });
        }
        const deleteResult = await donationsCollection.deleteOne({ _id: new ObjectId(donationId) });

        if (deleteResult.deletedCount === 0) {
          return res.status(500).send({ error: 'Failed to delete donation' });
        }
        await donationCampaignsCollection.updateOne(
          { _id: new ObjectId(donation.donationId) },
          { $inc: { donatedAmount: -donation.amount } }
        );

        res.send({ success: true, message: 'Donation refunded successfully' });
      } catch (error) {
        console.error('Refund error:', error);
        res.status(500).send({ error: 'Server error' });
      }
    });


    // Start server
    app.listen(port, () => {
      console.log(`Server running on http://localhost:${port}`);
    });
  } catch (err) {
    console.error("Failed to connect:", err);
  }
}

run();
