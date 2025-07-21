require("dotenv").config();
const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");

const app = express();
const port = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

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
      const result = await usersCollection.insertOne(user);
      res.send(result);
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

    // GET /pets?search=cat&category=Cat&page=1&limit=10
    app.get("/pets", async (req, res) => {
      try {
        const { search = "", category, page = 1, limit = 10 } = req.query;

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




    // Start server
    app.listen(port, () => {
      console.log(`Server running on http://localhost:${port}`);
    });
  } catch (err) {
    console.error("Failed to connect:", err);
  }
}

run();
