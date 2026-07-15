#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { AcardStack } from "../lib/acard-stack";

const app = new cdk.App();
new AcardStack(app, "AcardStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? "af-south-1",
  },
});
