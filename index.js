require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion } = require("mongodb");
const admin = require("firebase-admin");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

const port = process.env.PORT || 5000;
const decoded = Buffer.from(process.env.FB_SERVICE_KEY, "base64").toString(
  "utf-8"
);
const serviceAccount = JSON.parse(decoded);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const app = express();

// middleware
app.use(
  cors({
    origin: [process.env.CLIENT_DOMAIN],
    credentials: true,
    optionSuccessStatus: 200,
  })
);
app.use(express.json());

// jwt middlewares
const verifyJWT = async (req, res, next) => {
  const token = req?.headers?.authorization?.split(" ")[1];
  if (!token) return res.status(401).send({ message: "Unauthorized Access!" });
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.tokenEmail = decoded.email;
    next();
  } catch (err) {
    console.log(err);
    return res.status(401).send({ message: "Unauthorized Access!", err });
  }
};

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(process.env.MONGODB_URI, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});
async function run() {
  try {
    const db = client.db("assetsDB");

    const usersCollection = db.collection("users");
    const assetsCollection = db.collection("assets");
    const employeeAffiliationsCollection = db.collection(
      "employeeAffiliations"
    );
    const requestsCollection = db.collection("requests");
    const assignedAssetsCollection = db.collection("assignedAssets");
    const packagesCollection = db.collection("packages");
    const paymentsCollection = db.collection("payments");

    // save or update an user
    app.post("/user", async (req, res) => {
      const userData = req.body;
      const query = { email: userData.email };
      const existingUser = await usersCollection.findOne(query);

      if (existingUser) {
        await usersCollection.updateOne(query, {
          $set: userData,
          updatedAt: new Date(),
        });
        return res.send({ message: "User updated" });
      }

      userData.createdAt = new Date();
      userData.updatedAt = new Date();
      const result = await usersCollection.insertOne(userData);
      res.send(result);
    });

    // Get user role
    app.get("/user/role", verifyJWT, async (req, res) => {
      const user = await usersCollection.findOne({ email: req.tokenEmail });
      res.send({ role: user?.role, companyName: user?.companyName });
    });

    // Assets

    // Add assets
    app.post("/assets", verifyJWT, async (req, res) => {
      const hr = await usersCollection.findOne({ email: req.tokenEmail });
      if (!hr || hr.role !== "hr") return res.status(403).send({ message: "HR only" });

      const { productName, productImage, productType, productQuantity } = req.body;
      const asset = {
        productName,
        productImage,
        productType,
        productQuantity,
        availableQuantity: productQuantity,
        hrEmail: hr.email,
        companyName: hr.companyName,
        dateAdded: new Date(),
      };
      const result = await assetsCollection.insertOne(asset);
      res.send(result);
    });

    

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
    // Ensures that the client will close when you finish/error
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Welcome to AssetVerse Server");
});

app.listen(port, () => {
  console.log(`AssetVerse server is running on port ${port}`);
});
