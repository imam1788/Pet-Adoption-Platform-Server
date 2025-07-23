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
    app.get("/users/:email", async (req, res) => {
      const email = req.params.email;
      const user = await usersCollection.findOne({ email });
      res.send(user);
    });


    // Create JWT Token
    app.post("/jwt", (req, res) => {
      const user = req.body;
      const token = jwt.sign(user, process.env.JWT_SECRET, {
        expiresIn: "7d",
      });

      res.send({ token });
    });

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

    app.post("/adoptions", async (req, res) => {
      try {
        const adoption = req.body;
        const result = await adoptionsCollection.insertOne(adoption);
        res.send(result);
      } catch (error) {
        res.status(500).send({ error: "Failed to submit adoption request" });
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
    app.post('/donation-campaigns', async (req, res) => {
      try {
        console.log('Incoming donation campaign:', req.body); // 👈 log input

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

        console.log('Inserting campaign:', campaign); // 👈 log prepared data

        const result = await donationCampaignsCollection.insertOne(campaign);

        res.send(result);
      } catch (error) {
        console.error('❌ Server error on /donation-campaigns:', error);
        res.status(500).send({ error: 'Failed to create donation campaign' });
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



    // Start server
    app.listen(port, () => {
      console.log(`Server running on http://localhost:${port}`);
    });
  } catch (err) {
    console.error("Failed to connect:", err);
  }
}

run();
