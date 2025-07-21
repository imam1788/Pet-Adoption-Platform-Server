require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion } = require("mongodb");

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


    app.listen(port, () => {
      console.log(`Server is listening on http://localhost:${port}`);
    });
  } catch (err) {
    console.error("Failed to connect:", err);
  }
}

run();
