import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as rds from "aws-cdk-lib/aws-rds";
import * as logs from "aws-cdk-lib/aws-logs";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";

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
 * A-CARD on AWS — the smallest footprint that is still a real, durable
 * deployment: one VPC, one Postgres instance, one ALB, three Fargate
 * services (api, mcp, dashboard) that share it by path.
 *
 * Deliberately cost-conscious for a solo-founder MVP rather than "enterprise
 * default": no NAT Gateway (Fargate tasks run in public subnets with public
 * IPs; RDS sits in the same subnets but its security group only accepts
 * inbound Postgres traffic from the ECS tasks' security group — nothing
 * else can reach it). Before this handles real cardholder money in
 * production, move RDS and the tasks into private subnets behind a NAT
 * Gateway or VPC endpoints; that's a one-line change once the cost is
 * justified, not a re-architecture.
 */
export class AcardStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ---- parameters (set at `cdk deploy --parameters ...`) --------------------

    const issuerWebhookSecretParam = new cdk.CfnParameter(this, "IssuerWebhookSecret", {
      type: "String",
      noEcho: true,
      description: "Shared HMAC secret with the issuer (or the sandbox simulator) for /webhooks/issuer",
    });
    const paystackSecretKeyParam = new cdk.CfnParameter(this, "PaystackSecretKey", {
      type: "String",
      noEcho: true,
      default: "",
      description: "Paystack secret key (sk_live_... / sk_test_...). Leave blank to run unmetered.",
    });
    const paystackWebhookSecretParam = new cdk.CfnParameter(this, "PaystackWebhookSecret", {
      type: "String",
      noEcho: true,
      default: "",
      description: "Paystack webhook signing secret from the dashboard's API Keys & Webhooks page.",
    });
    const slackWebhookUrlParam = new cdk.CfnParameter(this, "SlackApprovalsWebhookUrl", {
      type: "String",
      noEcho: true,
      default: "",
      description: "Slack incoming webhook URL for approval-request notifications. Leave blank to disable.",
    });

    // ---- networking -------------------------------------------------------------

    const vpc = new ec2.Vpc(this, "Vpc", {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [{ name: "public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 }],
    });

    const dbSecurityGroup = new ec2.SecurityGroup(this, "DbSecurityGroup", { vpc, description: "A-CARD RDS" });
    const serviceSecurityGroup = new ec2.SecurityGroup(this, "ServiceSecurityGroup", {
      vpc,
      description: "A-CARD Fargate services",
    });
    dbSecurityGroup.addIngressRule(serviceSecurityGroup, ec2.Port.tcp(5432), "Fargate services -> Postgres");

    // ---- database -----------------------------------------------------------------

    const db = new rds.DatabaseInstance(this, "Database", {
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_16 }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.BURSTABLE4_GRAVITON, ec2.InstanceSize.MICRO),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroups: [dbSecurityGroup],
      databaseName: "acard",
      credentials: rds.Credentials.fromGeneratedSecret("acard"),
      allocatedStorage: 20,
      publiclyAccessible: false,
      backupRetention: cdk.Duration.days(7),
      deletionProtection: true,
      removalPolicy: cdk.RemovalPolicy.SNAPSHOT,
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

    // ---- shared secrets -------------------------------------------------------------

    const issuerWebhookSecret = new secretsmanager.Secret(this, "IssuerWebhookSecretValue", {
      secretStringValue: cdk.SecretValue.cfnParameter(issuerWebhookSecretParam),
    });
    const paystackSecretKey = new secretsmanager.Secret(this, "PaystackSecretKeyValue", {
      secretStringValue: cdk.SecretValue.cfnParameter(paystackSecretKeyParam),
    });
    const paystackWebhookSecret = new secretsmanager.Secret(this, "PaystackWebhookSecretValue", {
      secretStringValue: cdk.SecretValue.cfnParameter(paystackWebhookSecretParam),
    });
    const slackWebhookUrlSecret = new secretsmanager.Secret(this, "SlackApprovalsWebhookUrlValue", {
      secretStringValue: cdk.SecretValue.cfnParameter(slackWebhookUrlParam),
    });

    // ---- cluster + load balancer -------------------------------------------------------

    const cluster = new ecs.Cluster(this, "Cluster", { vpc, containerInsights: true });

    const alb = new elbv2.ApplicationLoadBalancer(this, "Alb", { vpc, internetFacing: true });
    // No default action here — the dashboard's `addTargetGroups` call below (added
    // without a path condition) becomes the listener's default action.
    const listener = alb.addListener("HttpListener", { port: 80, open: true });

    const logGroup = (name: string) => new logs.LogGroup(this, name, { retention: logs.RetentionDays.TWO_WEEKS });

    // ---- API service --------------------------------------------------------------------

    const apiTaskDef = new ecs.FargateTaskDefinition(this, "ApiTaskDef", { cpu: 256, memoryLimitMiB: 512 });
    const apiContainer = apiTaskDef.addContainer("api", {
      image: ecs.ContainerImage.fromAsset("../..", { file: "apps/api/Dockerfile", exclude: DOCKER_ASSET_EXCLUDES }),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: "api", logGroup: logGroup("ApiLogGroup") }),
      environment: { PORT: "8787" },
      secrets: {
        DATABASE_URL: ecs.Secret.fromSecretsManager(databaseUrlSecret),
        ISSUER_WEBHOOK_SECRET: ecs.Secret.fromSecretsManager(issuerWebhookSecret),
        PAYSTACK_SECRET_KEY: ecs.Secret.fromSecretsManager(paystackSecretKey),
        PAYSTACK_WEBHOOK_SECRET: ecs.Secret.fromSecretsManager(paystackWebhookSecret),
        SLACK_APPROVALS_WEBHOOK_URL: ecs.Secret.fromSecretsManager(slackWebhookUrlSecret),
      },
    });
    apiContainer.addPortMappings({ containerPort: 8787 });

    const apiService = new ecs.FargateService(this, "ApiService", {
      cluster,
      taskDefinition: apiTaskDef,
      desiredCount: 1,
      assignPublicIp: true,
      securityGroups: [serviceSecurityGroup],
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    });
    db.connections.allowFrom(apiService, ec2.Port.tcp(5432));

    listener.addTargets("ApiTargets", {
      port: 8787,
      protocol: elbv2.ApplicationProtocol.HTTP,
      priority: 10,
      conditions: [elbv2.ListenerCondition.pathPatterns(["/v1/*", "/webhooks/*", "/health"])],
      targets: [apiService],
      healthCheck: { path: "/health" },
    });

    // ---- MCP service (remote/HTTP transport) ---------------------------------------------

    const mcpTaskDef = new ecs.FargateTaskDefinition(this, "McpTaskDef", { cpu: 256, memoryLimitMiB: 512 });
    const mcpContainer = mcpTaskDef.addContainer("mcp", {
      image: ecs.ContainerImage.fromAsset("../..", { file: "apps/mcp/Dockerfile", exclude: DOCKER_ASSET_EXCLUDES }),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: "mcp", logGroup: logGroup("McpLogGroup") }),
      environment: {
        MCP_HTTP_PORT: "8788",
        // Internal DNS name Cloud Map / Cloud Discovery gives the API service — simplest
        // reliable option here is routing through the same ALB the public internet uses.
        ACARD_API_URL: `http://${alb.loadBalancerDnsName}`,
      },
    });
    mcpContainer.addPortMappings({ containerPort: 8788 });

    const mcpService = new ecs.FargateService(this, "McpService", {
      cluster,
      taskDefinition: mcpTaskDef,
      desiredCount: 1,
      assignPublicIp: true,
      securityGroups: [serviceSecurityGroup],
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    });

    listener.addTargets("McpTargets", {
      port: 8788,
      protocol: elbv2.ApplicationProtocol.HTTP,
      priority: 20,
      conditions: [elbv2.ListenerCondition.pathPatterns(["/mcp*"])],
      targets: [mcpService],
      healthCheck: { path: "/health" },
    });

    // ---- Dashboard service (default route) --------------------------------------------------

    const dashboardTaskDef = new ecs.FargateTaskDefinition(this, "DashboardTaskDef", { cpu: 256, memoryLimitMiB: 512 });
    dashboardTaskDef
      .addContainer("dashboard", {
        image: ecs.ContainerImage.fromAsset("../..", {
          file: "apps/dashboard/Dockerfile",
          // Empty (not omitted): the dashboard and API share this same ALB by path
          // (see the target group routing below), so relative/same-origin fetches
          // just work — and unlike the ALB's own DNS name, "" is known at Docker
          // build time, which an absolute URL referencing the not-yet-created ALB
          // cannot be.
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
      assignPublicIp: true,
      securityGroups: [serviceSecurityGroup],
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    });

    listener.addTargetGroups("DefaultDashboard", {
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

    // ---- outputs -------------------------------------------------------------------------

    new cdk.CfnOutput(this, "LoadBalancerUrl", { value: `http://${alb.loadBalancerDnsName}` });
    new cdk.CfnOutput(this, "ApiUrl", { value: `http://${alb.loadBalancerDnsName}` });
    new cdk.CfnOutput(this, "McpUrl", { value: `http://${alb.loadBalancerDnsName}/mcp` });
    new cdk.CfnOutput(this, "DashboardUrl", { value: `http://${alb.loadBalancerDnsName}` });
  }
}
