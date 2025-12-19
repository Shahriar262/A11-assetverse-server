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
      if (!hr || hr.role !== "hr")
        return res.status(403).send({ message: "HR only" });

      const { productName, productImage, productType, productQuantity } =
        req.body;
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

    // Get all assets for HR's company
    app.get("/assets", verifyJWT, async (req, res) => {
      const hr = await usersCollection.findOne({ email: req.tokenEmail });
      if (!hr) return res.status(403).send({ message: "unauthorized" });
      const assets = await assetsCollection
        .find({ companyName: hr.companyName })
        .toArray();
      res.send(assets);
    });

    // Get available assets for employees
    app.get("/available-assets", verifyJWT, async (req, res) => {
      const assets = await assetsCollection
        .find({ availableQuantity: { $gt: 0 } })
        .toArray();
      res.send(assets);
    });

    // Employee requests an asset
    app.post("/requests", verifyJWT, async (req, res) => {
      const employee = await usersCollection.findOne({ email: req.tokenEmail });
      if (!employee) return res.status(403).send({ message: "Unauthorized" });

      const { assetId, note } = req.body;
      const asset = await assetsCollection.findOne({
        _id: new ObjectId(assetId),
      });
      if (!asset) return res.status(404).send({ message: "Asset not found" });

      const request = {
        assetId: asset._id,
        assetName: asset.productName,
        assetType: asset.productType,
        requesterName: employee.name,
        requesterEmail: employee.email,
        hrEmail: asset.hrEmail,
        companyName: asset.companyName,
        requestDate: new Date(),
        requestStatus: "pending",
        note: note || "",
      };
      const result = await requestsCollection.insertOne(request);
      res.send(result);
    });

    // HR approves request
    app.patch("/requests/:id/approve", verifyJWT, async (req, res) => {
      const hr = await usersCollection.findOne({ email: req.tokenEmail });
      if (!hr || hr.role !== "hr")
        return res.status(403).send({ message: "HR only" });

      const requestId = req.params.id;
      const request = await requestsCollection.findOne({
        _id: new ObjectId(requestId),
      });
      if (!request)
        return res.status(404).send({ message: "Request not found" });

      // Update request status
      await requestsCollection.updateOne(
        { _id: request._id },
        {
          $set: {
            requestStatus: "approved",
            approvalDate: new Date(),
            processedBy: hr.email,
          },
        }
      );

      // Update asset quantity
      await assetsCollection.updateOne(
        { _id: request.assetId },
        { $inc: { availableQuantity: -1 } }
      );

      // Create assigned asset
      await assignedAssetsCollection.insertOne({
        assetId: request.assetId,
        assetName: request.assetName,
        assetImage: request.assetImage,
        assetType: request.assetType,
        employeeEmail: request.requesterEmail,
        employeeName: request.requesterName,
        hrEmail: hr.email,
        companyName: hr.companyName,
        assignmentDate: new Date(),
        status: "assigned",
      });

      // Create affiliation if first time
      const affiliationExists = await employeeAffiliationsCollection.findOne({
        employeeEmail: request.requesterEmail,
        companyName: hr.companyName,
      });
      if (!affiliationExists) {
        await employeeAffiliationsCollection.insertOne({
          employeeEmail: request.requesterEmail,
          employeeName: request.requesterName,
          hrEmail: hr.email,
          companyName: hr.companyName,
          companyLogo: hr.companyLogo,
          affiliationDate: new Date(),
          status: "active",
        });
      }

      res.send({ message: "Request approved and assigned" });
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
