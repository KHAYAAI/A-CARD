import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as rds from "aws-cdk-lib/aws-rds";
import * as logs from "aws-cdk-lib/aws-logs";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as route53targets from "aws-cdk-lib/aws-route53-targets";
import * as wafv2 from "aws-cdk-lib/aws-wafv2";
import * as cloudtrail from "aws-cdk-lib/aws-cloudtrail";
import * as guardduty from "aws-cdk-lib/aws-guardduty";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as firehose from "aws-cdk-lib/aws-kinesisfirehose";

/** Kept out of every Docker build context asset — each Dockerfile does its own npm ci/next build. */
const DOCKER_ASSET_EXCLUDES = [
  "infra/cdk/cdk.out",
  "infra/cdk/node_modules",
  "**/node_modules",
  "**/.git",
  "**/.next",
  "**/dist",
  "**/*.tsbuildinfo",
];

/**
 * Optional custom domain + TLS, configured at synth time (no CfnConditions,
 * no Route53 lookups that need live credentials):
 *
 *   cdk deploy -c domain=app.example.com -c hostedZoneId=Z123 -c hostedZoneName=example.com
 *
 * With all three set, the stack provisions an ACM certificate (DNS-validated
 * against the given hosted zone), an HTTPS:443 listener, an HTTP:80 → HTTPS
 * redirect, and a Route53 alias record. Without them it serves plain HTTP on
 * :80 — fine for a first look, not for real cardholder money.
 */
interface DomainConfig {
  domain: string;
  hostedZoneId: string;
  hostedZoneName: string;
}

/**
 * A-CARD on AWS — hardened for a real (if small) production deployment:
 *
 *  - ALB in public subnets; Fargate tasks in private-with-egress subnets;
 *    RDS in isolated subnets. Nothing but the ALB has a public route in.
 *  - Two NAT Gateways (one per AZ) give the tasks outbound access (ECR image
 *    pulls, Stripe, PayFast, Slack, WorkOS) without exposing them, and without a
 *    single-AZ outbound failure point.
 *  - Optional ACM/TLS + custom domain with an HTTP→HTTPS redirect.
 *  - A WAFv2 WebACL (AWS managed rule sets + a rate limit) fronts the ALB,
 *    with full request logs shipped to S3 via Kinesis Data Firehose, and the
 *    ALB's own access logs going straight to the same bucket.
 *  - CloudTrail records every AWS API call against this account; GuardDuty
 *    watches for threats. Neither touches the application — both are
 *    account/region-level AWS services turned on alongside it.
 *  - RDS runs Multi-AZ: a synchronously replicated standby in a second AZ
 *    that RDS fails over to automatically if the primary's AZ has an issue.
 *  - The API, MCP, and dashboard services scale out on CPU utilization —
 *    desiredCount is now a floor (minCapacity), not a fixed count.
 *  - The API runs the Postgres multi-writer store, so desiredCount can exceed 1.
 */
export class AcardStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const domainConfig = this.resolveDomainConfig();

    // ---- parameters (set at `cdk deploy --parameters ...`) --------------------

    const issuerWebhookSecretParam = new cdk.CfnParameter(this, "IssuerWebhookSecret", {
      type: "String",
      noEcho: true,
      description: "Shared HMAC secret with the issuer (or the sandbox simulator) for /webhooks/issuer",
    });
    const stripeSecretKeyParam = new cdk.CfnParameter(this, "StripeSecretKey", {
      type: "String",
      noEcho: true,
      default: "",
      description: "Stripe secret key (sk_live_... / sk_test_...) for USD subscription billing. Leave blank to run unmetered.",
    });
    const stripeWebhookSecretParam = new cdk.CfnParameter(this, "StripeWebhookSecret", {
      type: "String",
      noEcho: true,
      default: "",
      description: "Stripe webhook signing secret from Developers → Webhooks → your endpoint.",
    });
    const slackWebhookUrlParam = new cdk.CfnParameter(this, "SlackApprovalsWebhookUrl", {
      type: "String",
      noEcho: true,
      default: "",
      description: "Slack incoming webhook URL for approval-request notifications. Leave blank to disable.",
    });
    const workosApiKeyParam = new cdk.CfnParameter(this, "WorkOsApiKey", {
      type: "String",
      noEcho: true,
      default: "",
      description: "WorkOS API key (sk_...). SSO is purely additive to password + MFA login; leave blank to run without it.",
    });
    const workosClientIdParam = new cdk.CfnParameter(this, "WorkOsClientId", {
      type: "String",
      noEcho: true,
      default: "",
      description: "WorkOS Client ID (client_...). Leave blank alongside WorkOsApiKey to run without SSO.",
    });
    const payfastMerchantIdParam = new cdk.CfnParameter(this, "PayFastMerchantId", {
      type: "String",
      noEcho: true,
      default: "",
      description: "PayFast merchant ID. Leave blank alongside the other PayFast params to keep instant sandbox wallet funding.",
    });
    const payfastMerchantKeyParam = new cdk.CfnParameter(this, "PayFastMerchantKey", {
      type: "String",
      noEcho: true,
      default: "",
      description: "PayFast merchant key.",
    });
    const payfastPassphraseParam = new cdk.CfnParameter(this, "PayFastPassphrase", {
      type: "String",
      noEcho: true,
      default: "",
      description: "PayFast security passphrase, set in the PayFast dashboard — signs every checkout and ITN.",
    });
    const payfastSandboxParam = new cdk.CfnParameter(this, "PayFastSandbox", {
      type: "String",
      default: "false",
      allowedValues: ["true", "false"],
      description: "\"true\" to use sandbox.payfast.co.za instead of the live PayFast host.",
    });

    // ---- networking: public ALB, private tasks, isolated database -------------

    const vpc = new ec2.Vpc(this, "Vpc", {
      maxAzs: 2,
      // One per AZ: the single-NAT MVP tradeoff was an AZ-level outbound
      // failure point (a NAT in AZ-A going down takes outbound access with
      // it for tasks scheduled there, even though AZ-B is fine). CDK places
      // one NAT per AZ automatically when natGateways == maxAzs.
      natGateways: 2,
      subnetConfiguration: [
        { name: "public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: "private", subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
        { name: "isolated", subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });

    const dbSecurityGroup = new ec2.SecurityGroup(this, "DbSecurityGroup", { vpc, description: "A-CARD RDS" });
    const serviceSecurityGroup = new ec2.SecurityGroup(this, "ServiceSecurityGroup", {
      vpc,
      description: "A-CARD Fargate services",
    });
    dbSecurityGroup.addIngressRule(serviceSecurityGroup, ec2.Port.tcp(5432), "Fargate services -> Postgres");

    // ---- database (isolated subnets, private) ---------------------------------

    const db = new rds.DatabaseInstance(this, "Database", {
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_16 }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.BURSTABLE4_GRAVITON, ec2.InstanceSize.MICRO),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [dbSecurityGroup],
      databaseName: "acard",
      credentials: rds.Credentials.fromGeneratedSecret("acard"),
      allocatedStorage: 20,
      storageEncrypted: true,
      publiclyAccessible: false,
      backupRetention: cdk.Duration.days(7),
      deletionProtection: true,
      removalPolicy: cdk.RemovalPolicy.SNAPSHOT,
      // Synchronously replicated standby in the second AZ; RDS fails over to
      // it automatically on an AZ outage or instance failure. Roughly
      // doubles the instance's own cost (the standby is billed the same as
      // the primary) — storage and backups are not duplicated again on top.
      multiAz: true,
    });

    const databaseUrlSecret = new secretsmanager.Secret(this, "DatabaseUrlSecret", {
      secretStringValue: cdk.SecretValue.unsafePlainText(
        cdk.Fn.join("", [
          "postgres://",
          db.secret!.secretValueFromJson("username").unsafeUnwrap(),
          ":",
          db.secret!.secretValueFromJson("password").unsafeUnwrap(),
          "@",
          db.instanceEndpoint.hostname,
          ":5432/acard",
        ]),
      ),
    });

    // ---- shared secrets -------------------------------------------------------

    const issuerWebhookSecret = new secretsmanager.Secret(this, "IssuerWebhookSecretValue", {
      secretStringValue: cdk.SecretValue.cfnParameter(issuerWebhookSecretParam),
    });
    const stripeSecretKey = new secretsmanager.Secret(this, "StripeSecretKeyValue", {
      secretStringValue: cdk.SecretValue.cfnParameter(stripeSecretKeyParam),
    });
    const stripeWebhookSecret = new secretsmanager.Secret(this, "StripeWebhookSecretValue", {
      secretStringValue: cdk.SecretValue.cfnParameter(stripeWebhookSecretParam),
    });
    const slackWebhookUrlSecret = new secretsmanager.Secret(this, "SlackApprovalsWebhookUrlValue", {
      secretStringValue: cdk.SecretValue.cfnParameter(slackWebhookUrlParam),
    });
    const workosApiKeySecret = new secretsmanager.Secret(this, "WorkOsApiKeyValue", {
      secretStringValue: cdk.SecretValue.cfnParameter(workosApiKeyParam),
    });
    const workosClientIdSecret = new secretsmanager.Secret(this, "WorkOsClientIdValue", {
      secretStringValue: cdk.SecretValue.cfnParameter(workosClientIdParam),
    });
    const payfastMerchantIdSecret = new secretsmanager.Secret(this, "PayFastMerchantIdValue", {
      secretStringValue: cdk.SecretValue.cfnParameter(payfastMerchantIdParam),
    });
    const payfastMerchantKeySecret = new secretsmanager.Secret(this, "PayFastMerchantKeyValue", {
      secretStringValue: cdk.SecretValue.cfnParameter(payfastMerchantKeyParam),
    });
    const payfastPassphraseSecret = new secretsmanager.Secret(this, "PayFastPassphraseValue", {
      secretStringValue: cdk.SecretValue.cfnParameter(payfastPassphraseParam),
    });

    // ---- cluster + load balancer ----------------------------------------------

    const cluster = new ecs.Cluster(this, "Cluster", { vpc, containerInsights: true });
    const alb = new elbv2.ApplicationLoadBalancer(this, "Alb", { vpc, internetFacing: true });

    // TLS + domain, if configured at synth time.
    let hostedZone: route53.IHostedZone | undefined;
    let certificate: acm.ICertificate | undefined;
    if (domainConfig) {
      hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, "Zone", {
        hostedZoneId: domainConfig.hostedZoneId,
        zoneName: domainConfig.hostedZoneName,
      });
      certificate = new acm.Certificate(this, "Certificate", {
        domainName: domainConfig.domain,
        validation: acm.CertificateValidation.fromDns(hostedZone),
      });
    }

    // The primary listener carries the traffic; when TLS is on, :80 only redirects.
    const primaryListener = certificate
      ? alb.addListener("HttpsListener", { port: 443, certificates: [certificate], open: true })
      : alb.addListener("HttpListener", { port: 80, open: true });

    if (certificate) {
      alb.addListener("HttpRedirect", {
        port: 80,
        open: true,
        defaultAction: elbv2.ListenerAction.redirect({ protocol: "HTTPS", port: "443", permanent: true }),
      });
    }

    const publicOrigin = domainConfig ? `https://${domainConfig.domain}` : `http://${alb.loadBalancerDnsName}`;

    const logGroup = (name: string) => new logs.LogGroup(this, name, { retention: logs.RetentionDays.TWO_WEEKS });

    const serviceVpcSubnets: ec2.SubnetSelection = { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS };

    // ---- API service (Postgres multi-writer store; desiredCount can be > 1) ----

    const apiTaskDef = new ecs.FargateTaskDefinition(this, "ApiTaskDef", { cpu: 256, memoryLimitMiB: 512 });
    const apiContainer = apiTaskDef.addContainer("api", {
      image: ecs.ContainerImage.fromAsset("../..", { file: "apps/api/Dockerfile", exclude: DOCKER_ASSET_EXCLUDES }),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: "api", logGroup: logGroup("ApiLogGroup") }),
      environment: { PORT: "8787", NODE_ENV: "production", DASHBOARD_URL: publicOrigin, PAYFAST_SANDBOX: payfastSandboxParam.valueAsString },
      secrets: {
        DATABASE_URL: ecs.Secret.fromSecretsManager(databaseUrlSecret),
        ISSUER_WEBHOOK_SECRET: ecs.Secret.fromSecretsManager(issuerWebhookSecret),
        STRIPE_SECRET_KEY: ecs.Secret.fromSecretsManager(stripeSecretKey),
        STRIPE_WEBHOOK_SECRET: ecs.Secret.fromSecretsManager(stripeWebhookSecret),
        SLACK_APPROVALS_WEBHOOK_URL: ecs.Secret.fromSecretsManager(slackWebhookUrlSecret),
        WORKOS_API_KEY: ecs.Secret.fromSecretsManager(workosApiKeySecret),
        WORKOS_CLIENT_ID: ecs.Secret.fromSecretsManager(workosClientIdSecret),
        PAYFAST_MERCHANT_ID: ecs.Secret.fromSecretsManager(payfastMerchantIdSecret),
        PAYFAST_MERCHANT_KEY: ecs.Secret.fromSecretsManager(payfastMerchantKeySecret),
        PAYFAST_PASSPHRASE: ecs.Secret.fromSecretsManager(payfastPassphraseSecret),
      },
    });
    apiContainer.addPortMappings({ containerPort: 8787 });

    const apiService = new ecs.FargateService(this, "ApiService", {
      cluster,
      taskDefinition: apiTaskDef,
      desiredCount: 2, // safe now: the Postgres store's per-wallet row lock handles concurrent writers
      assignPublicIp: false,
      securityGroups: [serviceSecurityGroup],
      vpcSubnets: serviceVpcSubnets,
    });
    db.connections.allowFrom(apiService, ec2.Port.tcp(5432));

    // `desiredCount` above is the floor these scale back down to (and what a
    // stack update briefly resets the running count to, before the next CPU
    // evaluation lets Application Auto Scaling correct it again — a known,
    // benign interaction between CloudFormation and ECS service autoscaling).
    apiService
      .autoScaleTaskCount({ minCapacity: 2, maxCapacity: 6 })
      .scaleOnCpuUtilization("ApiCpuScaling", { targetUtilizationPercent: 65, scaleInCooldown: cdk.Duration.minutes(2), scaleOutCooldown: cdk.Duration.seconds(60) });

    primaryListener.addTargets("ApiTargets", {
      port: 8787,
      protocol: elbv2.ApplicationProtocol.HTTP,
      priority: 10,
      conditions: [elbv2.ListenerCondition.pathPatterns(["/v1/*", "/webhooks/*", "/health"])],
      targets: [apiService],
      healthCheck: { path: "/health" },
    });

    // ---- MCP service (remote/HTTP transport) ----------------------------------

    const mcpTaskDef = new ecs.FargateTaskDefinition(this, "McpTaskDef", { cpu: 256, memoryLimitMiB: 512 });
    const mcpContainer = mcpTaskDef.addContainer("mcp", {
      image: ecs.ContainerImage.fromAsset("../..", { file: "apps/mcp/Dockerfile", exclude: DOCKER_ASSET_EXCLUDES }),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: "mcp", logGroup: logGroup("McpLogGroup") }),
      environment: {
        MCP_HTTP_PORT: "8788",
        // Reach the API over the same ALB the public internet uses.
        ACARD_API_URL: publicOrigin,
      },
    });
    mcpContainer.addPortMappings({ containerPort: 8788 });

    const mcpService = new ecs.FargateService(this, "McpService", {
      cluster,
      taskDefinition: mcpTaskDef,
      desiredCount: 1,
      assignPublicIp: false,
      securityGroups: [serviceSecurityGroup],
      vpcSubnets: serviceVpcSubnets,
    });
    mcpService
      .autoScaleTaskCount({ minCapacity: 1, maxCapacity: 3 })
      .scaleOnCpuUtilization("McpCpuScaling", { targetUtilizationPercent: 65, scaleInCooldown: cdk.Duration.minutes(2), scaleOutCooldown: cdk.Duration.seconds(60) });

    primaryListener.addTargets("McpTargets", {
      port: 8788,
      protocol: elbv2.ApplicationProtocol.HTTP,
      priority: 20,
      conditions: [elbv2.ListenerCondition.pathPatterns(["/mcp*"])],
      targets: [mcpService],
      healthCheck: { path: "/health" },
    });

    // ---- Dashboard service (default route) ------------------------------------

    const dashboardTaskDef = new ecs.FargateTaskDefinition(this, "DashboardTaskDef", { cpu: 256, memoryLimitMiB: 512 });
    dashboardTaskDef
      .addContainer("dashboard", {
        image: ecs.ContainerImage.fromAsset("../..", {
          file: "apps/dashboard/Dockerfile",
          // Empty (not omitted): dashboard + API share this ALB by path, so
          // same-origin fetches just work — and "" is known at build time,
          // unlike the not-yet-created ALB DNS name.
          buildArgs: { NEXT_PUBLIC_ACARD_API_URL: "" },
          exclude: DOCKER_ASSET_EXCLUDES,
        }),
        logging: ecs.LogDrivers.awsLogs({ streamPrefix: "dashboard", logGroup: logGroup("DashboardLogGroup") }),
      })
      .addPortMappings({ containerPort: 3000 });

    const dashboardService = new ecs.FargateService(this, "DashboardService", {
      cluster,
      taskDefinition: dashboardTaskDef,
      desiredCount: 1,
      assignPublicIp: false,
      securityGroups: [serviceSecurityGroup],
      vpcSubnets: serviceVpcSubnets,
    });
    dashboardService
      .autoScaleTaskCount({ minCapacity: 1, maxCapacity: 3 })
      .scaleOnCpuUtilization("DashboardCpuScaling", { targetUtilizationPercent: 65, scaleInCooldown: cdk.Duration.minutes(2), scaleOutCooldown: cdk.Duration.seconds(60) });

    primaryListener.addTargetGroups("DefaultDashboard", {
      targetGroups: [
        new elbv2.ApplicationTargetGroup(this, "DashboardTargets", {
          vpc,
          port: 3000,
          protocol: elbv2.ApplicationProtocol.HTTP,
          targets: [dashboardService],
          healthCheck: { path: "/" },
        }),
      ],
    });

    // ---- durable access logs (S3, behind ALB + WAF) ----------------------------
    //
    // Previously only sampled requests reached CloudWatch metrics — nothing
    // captured the full request stream anywhere durable. This bucket holds
    // both: ALB access logs written directly (AWS's ELB log-delivery service
    // account, granted automatically by `logAccessLogs`), and WAF's full
    // request log delivered via Kinesis Data Firehose — WAF cannot write to
    // S3 directly, only through Firehose, and AWS requires that delivery
    // stream's name to start with `aws-waf-logs-` or WAF refuses to accept it
    // as a logging destination.

    const accessLogsBucket = new s3.Bucket(this, "AccessLogsBucket", {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      lifecycleRules: [{ expiration: cdk.Duration.days(180) }],
      // Access/audit logs: keep the bucket if the stack is ever torn down,
      // same reasoning as RDS's SNAPSHOT removal policy above.
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    alb.logAccessLogs(accessLogsBucket, "alb");

    const wafLogDeliveryStream = new firehose.DeliveryStream(this, "WafLogDeliveryStream", {
      deliveryStreamName: "aws-waf-logs-acard",
      destination: new firehose.S3Bucket(accessLogsBucket, {
        dataOutputPrefix: "waf/",
        compression: firehose.Compression.GZIP,
      }),
    });

    // ---- WAF: AWS managed rule sets + a rate limit, associated with the ALB ----

    const webAcl = new wafv2.CfnWebACL(this, "WebAcl", {
      scope: "REGIONAL",
      defaultAction: { allow: {} },
      visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: "acardWebAcl", sampledRequestsEnabled: true },
      rules: [
        {
          // Tighter than the general 2000/5min rule below, and evaluated first: a
          // credential-stuffing run against /v1/auth/login gets cut off long before
          // it could ever trip the whole-ALB flood limit.
          name: "LoginRateLimit",
          priority: 0,
          action: { block: {} },
          statement: {
            rateBasedStatement: {
              limit: 20,
              aggregateKeyType: "IP",
              scopeDownStatement: {
                byteMatchStatement: {
                  fieldToMatch: { uriPath: {} },
                  positionalConstraint: "EXACTLY",
                  searchString: "/v1/auth/login",
                  textTransformations: [{ priority: 0, type: "NONE" }],
                },
              },
            },
          },
          visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: "loginRateLimit", sampledRequestsEnabled: true },
        },
        {
          name: "AWSCommon",
          priority: 1,
          overrideAction: { none: {} },
          statement: { managedRuleGroupStatement: { vendorName: "AWS", name: "AWSManagedRulesCommonRuleSet" } },
          visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: "awsCommon", sampledRequestsEnabled: true },
        },
        {
          name: "AWSKnownBadInputs",
          priority: 2,
          overrideAction: { none: {} },
          statement: { managedRuleGroupStatement: { vendorName: "AWS", name: "AWSManagedRulesKnownBadInputsRuleSet" } },
          visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: "awsKnownBadInputs", sampledRequestsEnabled: true },
        },
        {
          name: "RateLimit",
          priority: 3,
          action: { block: {} },
          statement: { rateBasedStatement: { limit: 2000, aggregateKeyType: "IP" } },
          visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: "rateLimit", sampledRequestsEnabled: true },
        },
      ],
    });

    new wafv2.CfnWebACLAssociation(this, "WebAclAssociation", {
      resourceArn: alb.loadBalancerArn,
      webAclArn: webAcl.attrArn,
    });

    new wafv2.CfnLoggingConfiguration(this, "WafLoggingConfig", {
      resourceArn: webAcl.attrArn,
      logDestinationConfigs: [wafLogDeliveryStream],
    });

    // ---- account-level audit & threat detection (CloudTrail + GuardDuty) ------
    //
    // Neither of these touches the application or the VPC — they're AWS
    // services watching the account itself: every AWS API call made against
    // it (CloudTrail), and automated analysis of VPC/DNS/CloudTrail activity
    // for known threat patterns (GuardDuty).

    new cloudtrail.Trail(this, "Trail"); // multi-region, all management events, log-file integrity validation — all on by default

    // One detector per account per region: if GuardDuty is already enabled
    // on this account/region outside this stack, this resource fails to
    // create on deploy — import the existing detector instead of duplicating it.
    new guardduty.CfnDetector(this, "GuardDutyDetector", {
      enable: true,
      findingPublishingFrequency: "FIFTEEN_MINUTES",
    });

    // ---- optional DNS alias ---------------------------------------------------

    if (domainConfig && hostedZone) {
      const recordName = domainConfig.domain.endsWith(`.${domainConfig.hostedZoneName}`)
        ? domainConfig.domain.slice(0, -1 * (domainConfig.hostedZoneName.length + 1))
        : "";
      new route53.ARecord(this, "AliasRecord", {
        zone: hostedZone,
        recordName: recordName || undefined,
        target: route53.RecordTarget.fromAlias(new route53targets.LoadBalancerTarget(alb)),
      });
    }

    // ---- outputs --------------------------------------------------------------

    new cdk.CfnOutput(this, "LoadBalancerUrl", { value: `http://${alb.loadBalancerDnsName}` });
    new cdk.CfnOutput(this, "PublicOrigin", { value: publicOrigin });
    new cdk.CfnOutput(this, "ApiUrl", { value: publicOrigin });
    new cdk.CfnOutput(this, "McpUrl", { value: `${publicOrigin}/mcp` });
    new cdk.CfnOutput(this, "DashboardUrl", { value: publicOrigin });
  }

  /** Read `-c domain=… -c hostedZoneId=… -c hostedZoneName=…`; all three required to enable TLS. */
  private resolveDomainConfig(): DomainConfig | undefined {
    const domain = this.node.tryGetContext("domain") as string | undefined;
    const hostedZoneId = this.node.tryGetContext("hostedZoneId") as string | undefined;
    const hostedZoneName = (this.node.tryGetContext("hostedZoneName") as string | undefined) ?? domain;
    if (!domain || !hostedZoneId || !hostedZoneName) return undefined;
    return { domain, hostedZoneId, hostedZoneName };
  }
}
