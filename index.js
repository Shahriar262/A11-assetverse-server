require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
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
    origin: ["http://localhost:5173"],
    credentials: true,
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

    // Role Middleware
    const verifyHR = async (req, res, next) => {
      const user = await usersCollection.findOne({ email: req.tokenEmail });
      if (!user || user.role !== "hr")
        return res.status(403).send({ message: "HR only action!" });
      next();
    };

    const verifyEmployee = async (req, res, next) => {
      const user = await usersCollection.findOne({ email: req.tokenEmail });
      if (!user || user.role !== "employee")
        return res.status(403).send({ message: "Employee only action!" });
      next();
    };

    
    // User & Profile Routes
   
    app.post("/user", async (req, res) => {
      try {
        const userData = req.body;
        userData.currentEmployees = userData.currentEmployees || 0;
        userData.packageLimit = userData.packageLimit || 0;
        userData.createdAt = new Date();
        userData.updatedAt = new Date();

        const existingUser = await usersCollection.findOne({
          email: userData.email,
        });
        if (existingUser) {
          const result = await usersCollection.updateOne(
            { email: userData.email },
            { $set: { ...userData, updatedAt: new Date() } }
          );
          return res.send(result);
        }

        const result = await usersCollection.insertOne(userData);
        res.send(result);
      } catch (err) {
        res.status(500).send({ message: "User creation failed", err });
      }
    });

    app.post("/user/employee", async (req, res) => {
      try {
        const userData = req.body;

        userData.companyAffiliations = userData.companyAffiliations || [];
        userData.createdAt = new Date();
        userData.updatedAt = new Date();

        const existingUser = await usersCollection.findOne({
          email: userData.email,
        });

        if (existingUser) {
          const result = await usersCollection.updateOne(
            { email: userData.email },
            { $set: { ...userData, updatedAt: new Date() } }
          );
          return res.send(result);
        }

        const result = await usersCollection.insertOne(userData);
        res.send(result);
      } catch (err) {
        res.status(500).send({ message: "Employee creation failed", err });
      }
    });

    app.get("/user/hr-info", verifyJWT, verifyHR, async (req, res) => {
      try {
        const hr = await usersCollection.findOne({ email: req.tokenEmail });
        if (!hr) return res.status(404).send({ message: "HR not found" });

        res.send({
          name: hr.name || hr.displayName,
          profileImage: hr.profileImage || "",
          company: hr.companyName
            ? {
                companyName: hr.companyName,
                companyLogo: hr.companyLogo || "",
              }
            : null,
        });
      } catch (err) {
        res.status(500).send({ message: "Failed to fetch HR info", err });
      }
    });

    app.get("/user/role", verifyJWT, async (req, res) => {
      try {
        const user = await usersCollection.findOne({ email: req.tokenEmail });
        res.send({ role: user?.role });
      } catch (err) {
        res.status(500).send({ message: "Error fetching role", err });
      }
    });

    app.patch("/user/update", verifyJWT, async (req, res) => {
      try {
        const updates = req.body;
        updates.updatedAt = new Date();
        const result = await usersCollection.updateOne(
          { email: req.tokenEmail },
          { $set: updates }
        );
        res.send(result);
      } catch (err) {
        res.status(500).send({ message: "Profile update failed", err });
      }
    });

    // Employee profile (no company by default)
    app.get("/profile", verifyJWT, async (req, res) => {
      const user = await usersCollection.findOne({ email: req.tokenEmail });

      if (!user) return res.status(404).send({ message: "User not found" });

      res.send({
        name: user.name,
        profileImage: user.profileImage,
        role: user.role,
      });
    });

    // GET /employee/companies
    app.get("/employee/companies", verifyJWT, async (req, res) => {
      try {
        const employeeEmail = req.tokenEmail; 

        const affiliations = await employeeAffiliationsCollection
          .find({ employeeEmail, status: "active" }) 
          .toArray();

        // Populate company info from HR / users collection
        const companies = await Promise.all(
          affiliations.map(async (aff) => {
            const hr = await usersCollection.findOne({ email: aff.hrEmail });
            return {
              companyName: hr?.companyName || "N/A",
              companyLogo: hr?.companyLogo || null,
            };
          })
        );

        res.send(companies);
      } catch (err) {
        console.error(err);
        res.status(500).send({ message: "Failed to fetch companies" });
      }
    });

    // -----------------------------
    // Assets Routes (HR)
    // -----------------------------
    // Add Asset
    app.post("/assets", verifyJWT, verifyHR, async (req, res) => {
      try {
        const {
          productName,
          productType,
          quantity,
          productImage,
          companyName,
        } = req.body;

        if (!productName || !productType || !quantity) {
          return res.status(400).send({ message: "Missing required fields" });
        }

        const qty = parseInt(quantity, 10);
        if (isNaN(qty) || qty <= 0) {
          return res.status(400).send({ message: "Invalid quantity" });
        }

        const asset = {
          name: productName,
          type: productType,
          quantity: qty,
          availableQuantity: qty,
          productImage: productImage || "",
          hrEmail: req.tokenEmail,
          companyName: companyName || "N/A",
          dateAdded: new Date(),
        };

        const result = await assetsCollection.insertOne(asset);

        res.send({
          message: "Asset added successfully",
          asset: { ...asset, _id: result.insertedId },
        });
      } catch (err) {
        console.error(err);
        res.status(500).send({ message: "Failed to add asset" });
      }
    });

    app.get("/assets", verifyJWT, async (req, res) => {
      try {
        const query =
          req.query.mine === "true" ? { hrEmail: req.tokenEmail } : {};
        const result = await assetsCollection.find(query).toArray();
        res.send(result);
      } catch (err) {
        res.status(500).send({ message: "Error fetching assets", err });
      }
    });

    app.delete("/assets/:id", verifyJWT, verifyHR, async (req, res) => {
      try {
        await assetsCollection.deleteOne({ _id: new ObjectId(req.params.id) });
        res.send({ message: "Asset deleted successfully" });
      } catch (err) {
        res.status(500).send({ message: "Failed to delete asset", err });
      }
    });

    // -----------------------------
    // Employee Requests
    // -----------------------------
    // POST request creation
    // POST /requests
    app.post("/requests", verifyJWT, verifyEmployee, async (req, res) => {
      try {
        const { assetId, note } = req.body;

        // 1. Find the asset in DB
        const asset = await assetsCollection.findOne({
          _id: new ObjectId(assetId),
        });

        if (!asset) {
          return res.status(404).send({ message: "Asset not found" });
        }

        if (asset.availableQuantity < 1) {
          return res.status(400).send({ message: "Asset not available" });
        }

        // 2. Check if employee already requested this asset and it's pending
        const existingRequest = await requestsCollection.findOne({
          assetId: asset._id,
          requesterEmail: req.tokenEmail,
          requestStatus: "pending",
        });

        if (existingRequest) {
          return res
            .status(400)
            .send({ message: "You already requested this asset" });
        }

        // 3. Fetch employee info
        const employee = await usersCollection.findOne({
          email: req.tokenEmail,
        });

        // 4. Create request object with correct asset fields
        const request = {
          assetId: asset._id,
          assetName: asset.name, 
          assetType: asset.type, 
          assetImage: asset.productImage, 
          requesterEmail: req.tokenEmail,
          requesterName: employee.name,
          hrEmail: asset.hrEmail,
          companyName: asset.companyName || "N/A",
          requestDate: new Date(),
          requestStatus: "pending",
          note: note || "",
        };

        // 5. Insert into requests collection
        const result = await requestsCollection.insertOne(request);

        res.send({
          message: "Request created successfully",
          request: { ...request, _id: result.insertedId },
        });
      } catch (err) {
        console.error(err);
        res.status(500).send({ message: "Request creation failed", err });
      }
    });

    
    // Get All Requests (HR)
   
    app.get("/requests/all", verifyJWT, verifyHR, async (req, res) => {
      try {
        const hrEmail = req.tokenEmail;

        const requests = await requestsCollection
          .find({ hrEmail })
          .project({
            requesterName: 1,
            assetName: 1,
            assetType: 1,
            assetImage: 1,
            requestDate: 1,
            requestStatus: 1,
            note: 1,
          })
          .toArray();

        res.send(requests);
      } catch (err) {
        console.error(err);
        res.status(500).send({ message: "Failed to fetch requests" });
      }
    });

    // Backend route: Get current HR info
    app.get("/hr/me", verifyJWT, verifyHR, async (req, res) => {
      try {
        const hrEmail = req.tokenEmail;
        const hr = await usersCollection.findOne(
          { email: hrEmail },
          { projection: { companyName: 1, name: 1, email: 1 } }
        );

        if (!hr) return res.status(404).send({ message: "HR not found" });

        res.send({
          companyName: hr.companyName || "N/A",
          name: hr.name,
          email: hr.email,
        });
      } catch (err) {
        console.error(err);
        res.status(500).send({ message: "Failed to fetch HR info", err });
      }
    });

    // GET assigned assets for logged-in employee
    app.get(
      "/assigned-assets/my",
      verifyJWT,
      verifyEmployee,
      async (req, res) => {
        try {
          const employeeEmail = req.tokenEmail;

          const assignedAssets = await assignedAssetsCollection
            .aggregate([
              {
                $match: {
                  employeeEmail,
                  status: { $in: ["assigned", "approved"] },
                },
              },
              {
                $lookup: {
                  from: "assets",
                  localField: "assetId",
                  foreignField: "_id",
                  as: "assetInfo",
                },
              },
              { $unwind: "$assetInfo" },
              {
                $project: {
                  _id: 1,
                  assetId: 1,
                  assetImage: "$assetInfo.productImage",
                  assetName: "$assetInfo.name",
                  assetType: "$assetInfo.type",
                  companyName: "$assetInfo.companyName",
                  assignmentDate: 1,
                  returnDate: 1,
                  status: 1,
                },
              },
            ])
            .toArray();

          res.send(assignedAssets);
        } catch (err) {
          console.error(err);
          res
            .status(500)
            .send({ message: "Failed to fetch assigned assets", err });
        }
      }
    );

    app.patch(
      "/requests/:id/approve",
      verifyJWT,
      verifyHR,
      async (req, res) => {
        try {
          const requestId = req.params.id;

          //  Validate request
          const request = await requestsCollection.findOne({
            _id: new ObjectId(requestId),
          });

          if (!request || request.requestStatus !== "pending") {
            return res.status(400).send({ message: "Invalid request" });
          }

          //  Validate asset
          const asset = await assetsCollection.findOne({
            _id: new ObjectId(request.assetId),
          });

          if (!asset || asset.availableQuantity < 1) {
            return res.status(400).send({ message: "Asset not available" });
          }

          //  Prevent duplicate assignment
          const alreadyAssigned = await assignedAssetsCollection.findOne({
            assetId: request.assetId,
            employeeEmail: request.requesterEmail,
            status: "assigned",
          });

          if (alreadyAssigned) {
            return res.status(400).send({ message: "Asset already assigned" });
          }

          //  HR package limit check
          const hr = await usersCollection.findOne({ email: request.hrEmail });
          if (hr?.packageLimit && hr.currentEmployees >= hr.packageLimit) {
            return res.status(403).send({
              message: "Employee limit reached. Upgrade package.",
            });
          }

          //  Reduce asset quantity
          await assetsCollection.updateOne(
            { _id: asset._id },
            { $inc: { availableQuantity: -1 } }
          );

          //  Update request
          await requestsCollection.updateOne(
            { _id: new ObjectId(requestId) },
            {
              $set: {
                requestStatus: "approved",
                approvalDate: new Date(),
                processedBy: req.tokenEmail,
              },
            }
          );

          //  Assign asset
          await assignedAssetsCollection.insertOne({
            assetId: request.assetId,
            assetName: request.assetName,
            assetType: request.assetType,
            employeeEmail: request.requesterEmail,
            employeeName: request.requesterName,
            hrEmail: request.hrEmail,
            companyName: request.companyName,
            assignmentDate: new Date(),
            status: "assigned",
          });

          // 8️⃣ Employee affiliation
          const affiliationExists =
            await employeeAffiliationsCollection.findOne({
              employeeEmail: request.requesterEmail,
              hrEmail: request.hrEmail,
              status: "active",
            });

          if (!affiliationExists) {
            await employeeAffiliationsCollection.insertOne({
              employeeEmail: request.requesterEmail,
              employeeName: request.requesterName,
              hrEmail: request.hrEmail,
              companyName: request.companyName,
              affiliationDate: new Date(),
              status: "active",
            });

            // Update employee profile (frontend profile fix)
            await usersCollection.updateOne(
              { email: request.requesterEmail },
              {
                $addToSet: {
                  companyAffiliations: {
                    companyName: request.companyName,
                    approvedBy: request.hrEmail,
                    approvedAt: new Date(),
                  },
                },
              }
            );

            // Increase HR employee count
            await usersCollection.updateOne(
              { email: request.hrEmail },
              { $inc: { currentEmployees: 1 } }
            );
          }

          res.send({ message: "Request approved successfully" });
        } catch (err) {
          console.error(err);
          res.status(500).send({ message: "Approval failed", err });
        }
      }
    );

    app.patch("/requests/:id/reject", verifyJWT, verifyHR, async (req, res) => {
      try {
        const requestId = req.params.id;

        const request = await requestsCollection.findOne({
          _id: new ObjectId(requestId),
        });

        if (!request || request.requestStatus !== "pending") {
          return res.status(400).send({ message: "Invalid request" });
        }

        await requestsCollection.updateOne(
          { _id: new ObjectId(requestId) },
          {
            $set: {
              requestStatus: "rejected",
              approvalDate: new Date(),
              processedBy: req.tokenEmail,
            },
          }
        );

        res.send({ message: "Request rejected" });
      } catch (err) {
        res.status(500).send({ message: "Rejection failed", err });
      }
    });

    // -----------------------------
    // Assigned Assets
    // -----------------------------
    app.get(
      "/assigned-assets/my",
      verifyJWT,
      verifyEmployee,
      async (req, res) => {
        try {
          const result = await assignedAssetsCollection
            .find({ employeeEmail: req.tokenEmail })
            .toArray();
          res.send(result);
        } catch (err) {
          res
            .status(500)
            .send({ message: "Error fetching assigned assets", err });
        }
      }
    );

    app.patch(
      "/assigned-assets/:id/return",
      verifyJWT,
      verifyEmployee,
      async (req, res) => {
        try {
          const assignedId = req.params.id;
          const assignedAsset = await assignedAssetsCollection.findOne({
            _id: new ObjectId(assignedId),
            employeeEmail: req.tokenEmail,
          });
          if (!assignedAsset || assignedAsset.status !== "assigned")
            return res.status(400).send({ message: "Invalid return request" });

          await assignedAssetsCollection.updateOne(
            { _id: new ObjectId(assignedId) },
            { $set: { status: "returned", returnDate: new Date() } }
          );
          await assetsCollection.updateOne(
            { _id: new ObjectId(assignedAsset.assetId) },
            { $inc: { availableQuantity: 1 } }
          );

          await requestsCollection.updateOne(
            { assetId: assignedAsset.assetId, requesterEmail: req.tokenEmail },
            { $set: { requestStatus: "returned", approvalDate: new Date() } }
          );

          res.send({ message: "Asset returned successfully" });
        } catch (err) {
          res.status(500).send({ message: "Return failed", err });
        }
      }
    );

    
    // Packages & Payments
    
    app.get("/packages", verifyJWT, async (req, res) => {
      try {
        const result = await packagesCollection.find().toArray();
        res.send(result);
      } catch (err) {
        res.status(500).send({ message: "Error fetching packages", err });
      }
    });

    app.post(
      "/create-checkout-session",
      verifyJWT,
      verifyHR,
      async (req, res) => {
        try {
          const { packageId } = req.body;
          const pkg = await packagesCollection.findOne({
            _id: new ObjectId(packageId),
          });
          if (!pkg)
            return res.status(404).send({ message: "Package not found" });

          const session = await stripe.checkout.sessions.create({
            payment_method_types: ["card"],
            line_items: [
              {
                price_data: {
                  currency: "usd",
                  product_data: { name: pkg.name },
                  unit_amount: pkg.price * 100,
                },
                quantity: 1,
              },
            ],
            mode: "payment",
            customer_email: req.tokenEmail,
            success_url: `${process.env.CLIENT_DOMAIN}/payment-success`,
            cancel_url: `${process.env.CLIENT_DOMAIN}/packages`,
          });

          res.send({ url: session.url });
        } catch (err) {
          res.status(500).send({ message: "Checkout session failed", err });
        }
      }
    );

    app.post("/payment-success", verifyJWT, verifyHR, async (req, res) => {
      try {
        const { sessionId, packageId } = req.body;
        const session = await stripe.checkout.sessions.retrieve(sessionId);
        const pkg = await packagesCollection.findOne({
          _id: new ObjectId(packageId),
        });
        if (!pkg) return res.status(404).send({ message: "Package not found" });

        await paymentsCollection.insertOne({
          hrEmail: req.tokenEmail,
          packageName: pkg.name,
          employeeLimit: pkg.employeeLimit,
          amount: pkg.price,
          transactionId: session.payment_intent,
          paymentDate: new Date(),
          status: "completed",
        });

        await usersCollection.updateOne(
          { email: req.tokenEmail },
          { $set: { packageLimit: pkg.employeeLimit } }
        );

        res.send({ message: "Payment successful" });
      } catch (err) {
        res.status(500).send({ message: "Payment processing failed", err });
      }
    });

    app.get("/payments", verifyJWT, verifyHR, async (req, res) => {
      try {
        const payments = await paymentsCollection
          .find({ hrEmail: req.tokenEmail })
          .toArray();
        res.send(payments);
      } catch (err) {
        res.status(500).send({ message: "Failed to fetch payments", err });
      }
    });

  
    // HR Employee List
  
    app.get("/employees/my", verifyJWT, verifyHR, async (req, res) => {
      try {
        const hrEmail = req.tokenEmail;
        const employees = await employeeAffiliationsCollection
          .find({ hrEmail, status: "active" })
          .toArray();
        const hr = await usersCollection.findOne({ email: hrEmail });
        res.send({
          employees,
          currentEmployees: hr?.currentEmployees || 0,
          packageLimit: hr?.packageLimit || 0,
        });
      } catch (err) {
        res.status(500).send({ message: "Error fetching employees", err });
      }
    });

    app.patch(
      "/employees/:email/remove",
      verifyJWT,
      verifyHR,
      async (req, res) => {
        try {
          const employeeEmail = req.params.email;

          await employeeAffiliationsCollection.updateOne(
            { employeeEmail, hrEmail: req.tokenEmail },
            { $set: { status: "inactive" } }
          );

          await usersCollection.updateOne(
            { email: req.tokenEmail },
            { $inc: { currentEmployees: -1 } }
          );

          await usersCollection.updateOne(
            { email: employeeEmail },
            {
              $pull: {
                companyAffiliations: {
                  approvedBy: req.tokenEmail,
                },
              },
            }
          );

          res.send({ message: "Employee removed from team" });
        } catch (err) {
          res.status(500).send({ message: "Failed to remove employee", err });
        }
      }
    );

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
