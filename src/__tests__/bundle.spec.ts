import { providers } from "@0xsequence/multicall";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { expect } from "chai";
import { BigNumber } from "ethers";
import { parseEther } from "ethers/lib/utils";
import { ethers } from "hardhat";
import sinon from "sinon";
import { ItemType, MAX_INT } from "../constants";
import { TestERC1155, TestERC721 } from "../typechain";
import { CreateOrderInput, CurrencyItem } from "../types";
import * as fulfill from "../utils/fulfill";
import { generateRandomSalt } from "../utils/order";
import {
  getBalancesForFulfillOrder,
  verifyBalancesAfterFulfill,
} from "./utils/balance";
import { describeWithFixture } from "./utils/setup";

describeWithFixture(
  "As a user I want to buy now or accept an offer for a bundle of items",
  (fixture) => {
    let offerer: SignerWithAddress;
    let zone: SignerWithAddress;
    let fulfiller: SignerWithAddress;
    let multicallProvider: providers.MulticallProvider;

    let fulfillStandardOrderSpy: sinon.SinonSpy;
    let secondTestErc721: TestERC721;
    let secondTestErc1155: TestERC1155;
    let standardCreateOrderInput: CreateOrderInput;

    const nftId = "1";
    const nftId2 = "2";
    const erc1155Amount = "3";

    beforeEach(async () => {
      [offerer, zone, fulfiller] = await ethers.getSigners();
      multicallProvider = new providers.MulticallProvider(ethers.provider);

      fulfillStandardOrderSpy = sinon.spy(fulfill, "fulfillStandardOrder");

      const TestERC721 = await ethers.getContractFactory("TestERC721");
      secondTestErc721 = await TestERC721.deploy();
      await secondTestErc721.deployed();

      const TestERC1155 = await ethers.getContractFactory("TestERC1155");
      secondTestErc1155 = await TestERC1155.deploy();
      await secondTestErc1155.deployed();
    });

    afterEach(() => {
      fulfillStandardOrderSpy.restore();
    });

    describe("A bundle of ERC721s is to be transferred", async () => {
      describe("[Buy now] I want to buy a bundle of ERC721s", async () => {
        beforeEach(async () => {
          const { testErc721 } = fixture;

          // Mint 3 NFTs to offerer
          await testErc721.mint(offerer.address, nftId);
          await testErc721.mint(offerer.address, nftId2);
          await secondTestErc721.mint(offerer.address, nftId);

          standardCreateOrderInput = {
            startTime: "0",
            endTime: MAX_INT.toString(),
            salt: generateRandomSalt(),
            offer: [
              {
                itemType: ItemType.ERC721,
                token: testErc721.address,
                identifier: nftId,
              },
              {
                itemType: ItemType.ERC721,
                token: testErc721.address,
                identifier: nftId2,
              },
              {
                itemType: ItemType.ERC721,
                token: secondTestErc721.address,
                identifier: nftId,
              },
            ],
            consideration: [
              {
                amount: parseEther("10").toString(),
                recipient: offerer.address,
              },
            ],
            // 2.5% fee
            fees: [{ recipient: zone.address, basisPoints: 250 }],
          };
        });

        it("ERC721 <=> ETH", async () => {
          const { consideration, testErc721 } = fixture;

          const { executeAllActions } = await consideration.createOrder(
            standardCreateOrderInput
          );

          const order = await executeAllActions();

          const ownerToTokenToIdentifierBalances =
            await getBalancesForFulfillOrder(
              order,
              fulfiller.address,
              multicallProvider
            );

          const { actions } = await consideration.fulfillOrder(
            order,
            undefined,
            fulfiller.address
          );

          expect(actions.length).to.eq(1);

          const action = actions[0];

          expect(action).to.deep.equal({
            type: "exchange",
            transaction: action.transaction,
          });

          const transaction = await action.transaction.transact();
          const receipt = await transaction.wait();

          await verifyBalancesAfterFulfill({
            ownerToTokenToIdentifierBalances,
            order,
            fulfillerAddress: fulfiller.address,
            multicallProvider,
            fulfillReceipt: receipt,
          });

          // Double check nft balances
          const owners = await Promise.all([
            testErc721.ownerOf(nftId),
            testErc721.ownerOf(nftId2),
            secondTestErc721.ownerOf(nftId),
          ]);

          expect(owners.every((owner) => owner === fulfiller.address)).to.be
            .true;

          expect(fulfillStandardOrderSpy).calledOnce;
        });

        it("ERC721 <=> ERC20", async () => {
          const { consideration, testErc20, testErc721 } = fixture;

          // Use ERC20 instead of eth
          standardCreateOrderInput = {
            ...standardCreateOrderInput,
            consideration: standardCreateOrderInput.consideration.map(
              (item) => ({ ...item, token: testErc20.address })
            ),
          };

          await testErc20.mint(
            fulfiller.address,
            BigNumber.from(
              (standardCreateOrderInput.consideration[0] as CurrencyItem).amount
            )
          );

          const { executeAllActions } = await consideration.createOrder(
            standardCreateOrderInput
          );

          const order = await executeAllActions();

          const ownerToTokenToIdentifierBalances =
            await getBalancesForFulfillOrder(
              order,
              fulfiller.address,
              multicallProvider
            );

          const { actions } = await consideration.fulfillOrder(
            order,
            undefined,
            fulfiller.address
          );

          const approvalAction = actions[0];

          expect(approvalAction).to.deep.equal({
            type: "approval",
            token: testErc20.address,
            identifierOrCriteria: "0",
            itemType: ItemType.ERC20,
            transaction: approvalAction.transaction,
            operator: consideration.contract.address,
          });

          await approvalAction.transaction.transact();

          expect(
            await testErc20.allowance(
              fulfiller.address,
              consideration.contract.address
            )
          ).to.equal(MAX_INT);

          const fulfillAction = actions[1];

          expect(fulfillAction).to.be.deep.equal({
            type: "exchange",
            transaction: fulfillAction.transaction,
          });

          const transaction = await fulfillAction.transaction.transact();

          const receipt = await transaction.wait();

          await verifyBalancesAfterFulfill({
            ownerToTokenToIdentifierBalances,
            order,
            fulfillerAddress: fulfiller.address,
            multicallProvider,
            fulfillReceipt: receipt,
          });

          // Double check nft balances
          const owners = await Promise.all([
            testErc721.ownerOf(nftId),
            testErc721.ownerOf(nftId2),
            secondTestErc721.ownerOf(nftId),
          ]);

          expect(owners.every((owner) => owner === fulfiller.address)).to.be
            .true;

          expect(fulfillStandardOrderSpy).calledOnce;
        });
      });

      describe("[Accept offer] I want to accept an offer for my bundle of ERC721s", async () => {
        beforeEach(async () => {
          const { testErc20, testErc721 } = fixture;

          // Mint 3 NFTs to fulfiller
          await testErc721.mint(fulfiller.address, nftId);
          await testErc721.mint(fulfiller.address, nftId2);
          await secondTestErc721.mint(fulfiller.address, nftId);

          await testErc20.mint(offerer.address, parseEther("10").toString());

          standardCreateOrderInput = {
            startTime: "0",
            endTime: MAX_INT.toString(),
            salt: generateRandomSalt(),
            offer: [
              {
                amount: parseEther("10").toString(),
                token: testErc20.address,
              },
            ],
            consideration: [
              {
                itemType: ItemType.ERC721,
                token: testErc721.address,
                identifier: nftId,
                recipient: offerer.address,
              },
              {
                itemType: ItemType.ERC721,
                token: testErc721.address,
                identifier: nftId2,
                recipient: offerer.address,
              },
              {
                itemType: ItemType.ERC721,
                token: secondTestErc721.address,
                identifier: nftId,
                recipient: offerer.address,
              },
            ],
            // 2.5% fee
            fees: [{ recipient: zone.address, basisPoints: 250 }],
          };
        });

        it("ERC20 <=> ERC721", async () => {
          const { consideration, testErc721, testErc20 } = fixture;

          const { executeAllActions } = await consideration.createOrder(
            standardCreateOrderInput,
            offerer.address
          );

          const order = await executeAllActions();

          const ownerToTokenToIdentifierBalances =
            await getBalancesForFulfillOrder(
              order,
              fulfiller.address,
              multicallProvider
            );

          const { actions } = await consideration.fulfillOrder(
            order,
            undefined,
            fulfiller.address
          );

          const approvalAction = actions[0];

          expect(approvalAction).to.deep.equal({
            type: "approval",
            token: testErc721.address,
            identifierOrCriteria: nftId2,
            itemType: ItemType.ERC721,
            transaction: approvalAction.transaction,
            operator: consideration.contract.address,
          });

          await approvalAction.transaction.transact();

          expect(
            await testErc721.isApprovedForAll(
              fulfiller.address,
              consideration.contract.address
            )
          ).to.be.true;

          const secondApprovalAction = actions[1];

          expect(secondApprovalAction).to.deep.equal({
            type: "approval",
            token: secondTestErc721.address,
            identifierOrCriteria: nftId,
            itemType: ItemType.ERC721,
            transaction: secondApprovalAction.transaction,
            operator: consideration.contract.address,
          });

          await secondApprovalAction.transaction.transact();

          expect(
            await secondTestErc721.isApprovedForAll(
              fulfiller.address,
              consideration.contract.address
            )
          ).to.be.true;

          // We also need to approve ERC-20 as we send that out as fees..
          const thirdApprovalAction = actions[2];

          expect(thirdApprovalAction).to.deep.equal({
            type: "approval",
            token: testErc20.address,
            identifierOrCriteria: "0",
            itemType: ItemType.ERC20,
            transaction: thirdApprovalAction.transaction,
            operator: consideration.contract.address,
          });

          await thirdApprovalAction.transaction.transact();

          expect(
            await testErc20.allowance(
              fulfiller.address,
              consideration.contract.address
            )
          ).to.eq(MAX_INT);

          const fulfillAction = actions[3];

          expect(fulfillAction).to.be.deep.equal({
            type: "exchange",
            transaction: fulfillAction.transaction,
          });

          const transaction = await fulfillAction.transaction.transact();

          const receipt = await transaction.wait();

          await verifyBalancesAfterFulfill({
            ownerToTokenToIdentifierBalances,
            order,
            fulfillerAddress: fulfiller.address,
            multicallProvider,
            fulfillReceipt: receipt,
          });

          // Double check nft balances
          const owners = await Promise.all([
            testErc721.ownerOf(nftId),
            testErc721.ownerOf(nftId2),
            secondTestErc721.ownerOf(nftId),
          ]);

          expect(owners.every((owner) => owner === offerer.address)).to.be.true;

          expect(fulfillStandardOrderSpy).calledOnce;
        });
      });
    });

    describe("A bundle of ERC721s and ERC1155s is to be transferred", async () => {
      describe("[Buy now] I want to buy a bundle of ERC721s and ERC1155s", async () => {
        beforeEach(async () => {
          const { testErc721, testErc1155 } = fixture;

          // Mint 3 NFTs to offerer
          await testErc721.mint(offerer.address, nftId);
          await secondTestErc721.mint(offerer.address, nftId);
          await testErc1155.mint(offerer.address, nftId, erc1155Amount);

          standardCreateOrderInput = {
            startTime: "0",
            endTime: MAX_INT.toString(),
            salt: generateRandomSalt(),
            offer: [
              {
                itemType: ItemType.ERC721,
                token: testErc721.address,
                identifier: nftId,
              },
              {
                itemType: ItemType.ERC721,
                token: secondTestErc721.address,
                identifier: nftId,
              },
              {
                itemType: ItemType.ERC1155,
                token: testErc1155.address,
                identifier: nftId,
                amount: erc1155Amount,
              },
            ],
            consideration: [
              {
                amount: parseEther("10").toString(),
                recipient: offerer.address,
              },
            ],
            // 2.5% fee
            fees: [{ recipient: zone.address, basisPoints: 250 }],
          };
        });

        it("ERC721 + ERC1155 <=> ETH", async () => {
          const { consideration, testErc721, testErc1155 } = fixture;

          const { executeAllActions } = await consideration.createOrder(
            standardCreateOrderInput
          );

          const order = await executeAllActions();

          const ownerToTokenToIdentifierBalances =
            await getBalancesForFulfillOrder(
              order,
              fulfiller.address,
              multicallProvider
            );

          const { actions } = await consideration.fulfillOrder(
            order,
            undefined,
            fulfiller.address
          );

          expect(actions.length).to.eq(1);

          const action = actions[0];

          expect(action.type).eq("exchange");

          const transaction = await action.transaction.transact();
          const receipt = await transaction.wait();

          await verifyBalancesAfterFulfill({
            ownerToTokenToIdentifierBalances,
            order,
            fulfillerAddress: fulfiller.address,
            multicallProvider,
            fulfillReceipt: receipt,
          });

          // Double check nft balances
          const owners = await Promise.all([
            testErc721.ownerOf(nftId),
            secondTestErc721.ownerOf(nftId),
            testErc1155.balanceOf(fulfiller.address, nftId),
          ]);

          expect(
            owners.every(
              (ownerOrBalance) =>
                ownerOrBalance === fulfiller.address ||
                BigNumber.from(erc1155Amount).eq(ownerOrBalance)
            )
          ).to.be.true;

          expect(fulfillStandardOrderSpy).calledOnce;
        });

        it("ERC721 + ERC1155 <=> ERC20", async () => {
          const { consideration, testErc20, testErc721, testErc1155 } = fixture;

          // Use ERC20 instead of eth
          standardCreateOrderInput = {
            ...standardCreateOrderInput,
            consideration: standardCreateOrderInput.consideration.map(
              (item) => ({ ...item, token: testErc20.address })
            ),
          };

          await testErc20.mint(
            fulfiller.address,
            BigNumber.from(
              (standardCreateOrderInput.consideration[0] as CurrencyItem).amount
            )
          );

          const { executeAllActions } = await consideration.createOrder(
            standardCreateOrderInput
          );

          const order = await executeAllActions();

          const ownerToTokenToIdentifierBalances =
            await getBalancesForFulfillOrder(
              order,
              fulfiller.address,
              multicallProvider
            );

          const { actions } = await consideration.fulfillOrder(
            order,
            undefined,
            fulfiller.address
          );

          const approvalAction = actions[0];

          expect(approvalAction).to.deep.equal({
            type: "approval",
            token: testErc20.address,
            identifierOrCriteria: "0",
            itemType: ItemType.ERC20,
            transaction: approvalAction.transaction,
            operator: consideration.contract.address,
          });

          await approvalAction.transaction.transact();

          expect(
            await testErc20.allowance(
              fulfiller.address,
              consideration.contract.address
            )
          ).to.equal(MAX_INT);

          const fulfillAction = actions[1];

          expect(fulfillAction).to.be.deep.equal({
            type: "exchange",
            transaction: fulfillAction.transaction,
          });

          const transaction = await fulfillAction.transaction.transact();

          const receipt = await transaction.wait();

          await verifyBalancesAfterFulfill({
            ownerToTokenToIdentifierBalances,
            order,
            fulfillerAddress: fulfiller.address,
            multicallProvider,
            fulfillReceipt: receipt,
          });

          // Double check nft balances
          const owners = await Promise.all([
            testErc721.ownerOf(nftId),
            secondTestErc721.ownerOf(nftId),
            testErc1155.balanceOf(fulfiller.address, nftId),
          ]);

          expect(
            owners.every(
              (ownerOrBalance) =>
                ownerOrBalance === fulfiller.address ||
                BigNumber.from(erc1155Amount).eq(ownerOrBalance)
            )
          ).to.be.true;

          expect(fulfillStandardOrderSpy).calledOnce;
        });
      });

      describe("[Accept offer] I want to accept an offer for my bundle of ERC721s and ERC1155s", async () => {
        beforeEach(async () => {
          const { testErc20, testErc721, testErc1155 } = fixture;

          // Mint 3 NFTs to fulfiller
          await testErc721.mint(fulfiller.address, nftId);
          await secondTestErc721.mint(fulfiller.address, nftId);
          await testErc1155.mint(fulfiller.address, nftId, erc1155Amount);

          await testErc20.mint(offerer.address, parseEther("10").toString());

          standardCreateOrderInput = {
            startTime: "0",
            endTime: MAX_INT.toString(),
            salt: generateRandomSalt(),
            offer: [
              {
                amount: parseEther("10").toString(),
                token: testErc20.address,
              },
            ],
            consideration: [
              {
                itemType: ItemType.ERC721,
                token: testErc721.address,
                identifier: nftId,
                recipient: offerer.address,
              },
              {
                itemType: ItemType.ERC721,
                token: secondTestErc721.address,
                identifier: nftId,
                recipient: offerer.address,
              },
              {
                itemType: ItemType.ERC1155,
                token: testErc1155.address,
                identifier: nftId,
                amount: erc1155Amount,
                recipient: offerer.address,
              },
            ],
            // 2.5% fee
            fees: [{ recipient: zone.address, basisPoints: 250 }],
          };
        });

        it("ERC20 <=> ERC721 + ERC1155", async () => {
          const { consideration, testErc721, testErc1155, testErc20 } = fixture;

          const { executeAllActions } = await consideration.createOrder(
            standardCreateOrderInput,
            offerer.address
          );

          const order = await executeAllActions();

          const ownerToTokenToIdentifierBalances =
            await getBalancesForFulfillOrder(
              order,
              fulfiller.address,
              multicallProvider
            );

          const { actions } = await consideration.fulfillOrder(
            order,
            undefined,
            fulfiller.address
          );

          const approvalAction = actions[0];

          expect(approvalAction).to.deep.equal({
            type: "approval",
            token: testErc721.address,
            identifierOrCriteria: nftId,
            itemType: ItemType.ERC721,
            transaction: approvalAction.transaction,
            operator: consideration.contract.address,
          });

          await approvalAction.transaction.transact();

          expect(
            await testErc721.isApprovedForAll(
              fulfiller.address,
              consideration.contract.address
            )
          ).to.be.true;

          const secondApprovalAction = actions[1];

          expect(secondApprovalAction).to.deep.equal({
            type: "approval",
            token: secondTestErc721.address,
            identifierOrCriteria: nftId,
            itemType: ItemType.ERC721,
            transaction: secondApprovalAction.transaction,
            operator: consideration.contract.address,
          });

          await secondApprovalAction.transaction.transact();

          expect(
            await secondTestErc721.isApprovedForAll(
              fulfiller.address,
              consideration.contract.address
            )
          ).to.be.true;

          const thirdApprovalAction = actions[2];

          expect(thirdApprovalAction).to.deep.equal({
            type: "approval",
            token: testErc1155.address,
            identifierOrCriteria: nftId,
            itemType: ItemType.ERC1155,
            transaction: thirdApprovalAction.transaction,
            operator: consideration.contract.address,
          });

          await thirdApprovalAction.transaction.transact();

          expect(
            await testErc1155.isApprovedForAll(
              fulfiller.address,
              consideration.contract.address
            )
          ).to.be.true;

          // We also need to approve ERC-20 as we send that out as fees..
          const fourthApprovalAction = actions[3];

          expect(fourthApprovalAction).to.deep.equal({
            type: "approval",
            token: testErc20.address,
            identifierOrCriteria: "0",
            itemType: ItemType.ERC20,
            transaction: fourthApprovalAction.transaction,
            operator: consideration.contract.address,
          });

          await fourthApprovalAction.transaction.transact();

          expect(
            await testErc20.allowance(
              fulfiller.address,
              consideration.contract.address
            )
          ).to.eq(MAX_INT);

          const fulfillAction = actions[4];

          expect(fulfillAction).to.be.deep.equal({
            type: "exchange",
            transaction: fulfillAction.transaction,
          });

          const transaction = await fulfillAction.transaction.transact();

          const receipt = await transaction.wait();

          await verifyBalancesAfterFulfill({
            ownerToTokenToIdentifierBalances,
            order,
            fulfillerAddress: fulfiller.address,
            multicallProvider,
            fulfillReceipt: receipt,
          });

          // Double check nft balances
          const owners = await Promise.all([
            testErc721.ownerOf(nftId),
            secondTestErc721.ownerOf(nftId),
            testErc1155.balanceOf(offerer.address, nftId),
          ]);

          expect(
            owners.every(
              (ownerOrBalance) =>
                ownerOrBalance === offerer.address ||
                BigNumber.from(erc1155Amount).eq(ownerOrBalance)
            )
          ).to.be.true;

          expect(fulfillStandardOrderSpy).calledOnce;
        });
      });
    });

    describe("A bundle of ERC1155s is to be transferred", async () => {
      describe("[Buy now] I want to buy a bundle of ERC1155s", async () => {
        beforeEach(async () => {
          const { testErc1155 } = fixture;

          // Mint 3 NFTs to offerer
          await testErc1155.mint(offerer.address, nftId, erc1155Amount);
          await testErc1155.mint(offerer.address, nftId2, erc1155Amount);
          await secondTestErc1155.mint(offerer.address, nftId, erc1155Amount);

          standardCreateOrderInput = {
            startTime: "0",
            endTime: MAX_INT.toString(),
            salt: generateRandomSalt(),
            offer: [
              {
                itemType: ItemType.ERC1155,
                token: testErc1155.address,
                identifier: nftId,
                amount: erc1155Amount,
              },
              {
                itemType: ItemType.ERC1155,
                token: testErc1155.address,
                identifier: nftId2,
                amount: erc1155Amount,
              },
              {
                itemType: ItemType.ERC1155,
                token: secondTestErc1155.address,
                identifier: nftId,
                amount: erc1155Amount,
              },
            ],
            consideration: [
              {
                amount: parseEther("10").toString(),
                recipient: offerer.address,
              },
            ],
            // 2.5% fee
            fees: [{ recipient: zone.address, basisPoints: 250 }],
          };
        });

        it("ERC1155 <=> ETH", async () => {
          const { consideration, testErc1155 } = fixture;

          const { executeAllActions } = await consideration.createOrder(
            standardCreateOrderInput
          );

          const order = await executeAllActions();

          const ownerToTokenToIdentifierBalances =
            await getBalancesForFulfillOrder(
              order,
              fulfiller.address,
              multicallProvider
            );

          const { actions } = await consideration.fulfillOrder(
            order,
            undefined,
            fulfiller.address
          );

          expect(actions.length).to.eq(1);

          const action = actions[0];

          expect(action.type).eq("exchange");

          const transaction = await action.transaction.transact();
          const receipt = await transaction.wait();

          await verifyBalancesAfterFulfill({
            ownerToTokenToIdentifierBalances,
            order,
            fulfillerAddress: fulfiller.address,
            multicallProvider,
            fulfillReceipt: receipt,
          });

          // Double check nft balances
          const owners = await Promise.all([
            testErc1155.balanceOf(fulfiller.address, nftId),
            testErc1155.balanceOf(fulfiller.address, nftId2),
            secondTestErc1155.balanceOf(fulfiller.address, nftId),
          ]);

          expect(
            owners.every((balance) => BigNumber.from(erc1155Amount).eq(balance))
          ).to.be.true;

          expect(fulfillStandardOrderSpy).calledOnce;
        });

        it("ERC1155 <=> ERC20", async () => {
          const { consideration, testErc20, testErc1155 } = fixture;

          // Use ERC20 instead of eth
          standardCreateOrderInput = {
            ...standardCreateOrderInput,
            consideration: standardCreateOrderInput.consideration.map(
              (item) => ({ ...item, token: testErc20.address })
            ),
          };

          await testErc20.mint(
            fulfiller.address,
            BigNumber.from(
              (standardCreateOrderInput.consideration[0] as CurrencyItem).amount
            )
          );

          const { executeAllActions } = await consideration.createOrder(
            standardCreateOrderInput
          );

          const order = await executeAllActions();

          const ownerToTokenToIdentifierBalances =
            await getBalancesForFulfillOrder(
              order,
              fulfiller.address,
              multicallProvider
            );

          const { actions } = await consideration.fulfillOrder(
            order,
            undefined,
            fulfiller.address
          );

          const approvalAction = actions[0];

          expect(approvalAction).to.deep.equal({
            type: "approval",
            token: testErc20.address,
            identifierOrCriteria: "0",
            itemType: ItemType.ERC20,
            transaction: approvalAction.transaction,
            operator: consideration.contract.address,
          });

          await approvalAction.transaction.transact();

          expect(
            await testErc20.allowance(
              fulfiller.address,
              consideration.contract.address
            )
          ).to.equal(MAX_INT);

          const fulfillAction = actions[1];

          expect(fulfillAction).to.be.deep.equal({
            type: "exchange",
            transaction: fulfillAction.transaction,
          });

          const transaction = await fulfillAction.transaction.transact();

          const receipt = await transaction.wait();

          await verifyBalancesAfterFulfill({
            ownerToTokenToIdentifierBalances,
            order,
            fulfillerAddress: fulfiller.address,
            multicallProvider,
            fulfillReceipt: receipt,
          });

          // Double check nft balances
          const owners = await Promise.all([
            testErc1155.balanceOf(fulfiller.address, nftId),
            testErc1155.balanceOf(fulfiller.address, nftId2),
            secondTestErc1155.balanceOf(fulfiller.address, nftId),
          ]);

          expect(
            owners.every((balance) => BigNumber.from(erc1155Amount).eq(balance))
          ).to.be.true;

          expect(fulfillStandardOrderSpy).calledOnce;
        });
      });

      describe("[Accept offer] I want to accept an offer for my bundle of ERC1155s", async () => {
        beforeEach(async () => {
          const { testErc20, testErc1155 } = fixture;

          // Mint 3 NFTs to fulfiller
          await testErc1155.mint(fulfiller.address, nftId, erc1155Amount);
          await testErc1155.mint(fulfiller.address, nftId2, erc1155Amount);
          await secondTestErc1155.mint(fulfiller.address, nftId, erc1155Amount);

          await testErc20.mint(offerer.address, parseEther("10").toString());

          standardCreateOrderInput = {
            startTime: "0",
            endTime: MAX_INT.toString(),
            salt: generateRandomSalt(),
            offer: [
              {
                amount: parseEther("10").toString(),
                token: testErc20.address,
              },
            ],
            consideration: [
              {
                itemType: ItemType.ERC1155,
                token: testErc1155.address,
                identifier: nftId,
                amount: erc1155Amount,
                recipient: offerer.address,
              },
              {
                itemType: ItemType.ERC1155,
                token: testErc1155.address,
                identifier: nftId2,
                amount: erc1155Amount,
                recipient: offerer.address,
              },
              {
                itemType: ItemType.ERC1155,
                token: secondTestErc1155.address,
                identifier: nftId,
                amount: erc1155Amount,
                recipient: offerer.address,
              },
            ],
            // 2.5% fee
            fees: [{ recipient: zone.address, basisPoints: 250 }],
          };
        });

        it("ERC20 <=> ERC1155", async () => {
          const { consideration, testErc1155, testErc20 } = fixture;

          const { executeAllActions } = await consideration.createOrder(
            standardCreateOrderInput,
            offerer.address
          );

          const order = await executeAllActions();

          const ownerToTokenToIdentifierBalances =
            await getBalancesForFulfillOrder(
              order,
              fulfiller.address,
              multicallProvider
            );

          const { actions } = await consideration.fulfillOrder(
            order,
            undefined,
            fulfiller.address
          );

          const approvalAction = actions[0];

          expect(approvalAction).to.deep.equal({
            type: "approval",
            token: testErc1155.address,
            identifierOrCriteria: nftId2,
            itemType: ItemType.ERC1155,
            transaction: approvalAction.transaction,
            operator: consideration.contract.address,
          });

          await approvalAction.transaction.transact();

          expect(
            await testErc1155.isApprovedForAll(
              fulfiller.address,
              consideration.contract.address
            )
          ).to.be.true;

          const secondApprovalAction = actions[1];

          expect(secondApprovalAction).to.deep.equal({
            type: "approval",
            token: secondTestErc1155.address,
            identifierOrCriteria: nftId,
            itemType: ItemType.ERC1155,
            transaction: secondApprovalAction.transaction,
            operator: consideration.contract.address,
          });

          await secondApprovalAction.transaction.transact();

          expect(
            await secondTestErc1155.isApprovedForAll(
              fulfiller.address,
              consideration.contract.address
            )
          ).to.be.true;

          // We also need to approve ERC-20 as we send that out as fees..
          const thirdApprovalAction = actions[2];

          expect(thirdApprovalAction).to.deep.equal({
            type: "approval",
            token: testErc20.address,
            identifierOrCriteria: "0",
            itemType: ItemType.ERC20,
            transaction: thirdApprovalAction.transaction,
            operator: consideration.contract.address,
          });

          await thirdApprovalAction.transaction.transact();

          expect(
            await testErc20.allowance(
              fulfiller.address,
              consideration.contract.address
            )
          ).to.eq(MAX_INT);

          const fulfillAction = actions[3];

          expect(fulfillAction).to.be.deep.equal({
            type: "exchange",
            transaction: fulfillAction.transaction,
          });

          const transaction = await fulfillAction.transaction.transact();

          const receipt = await transaction.wait();

          await verifyBalancesAfterFulfill({
            ownerToTokenToIdentifierBalances,
            order,
            fulfillerAddress: fulfiller.address,
            multicallProvider,
            fulfillReceipt: receipt,
          });

          // Double check nft balances
          const owners = await Promise.all([
            testErc1155.balanceOf(offerer.address, nftId),
            testErc1155.balanceOf(offerer.address, nftId2),
            secondTestErc1155.balanceOf(offerer.address, nftId),
          ]);

          expect(
            owners.every((balance) => BigNumber.from(erc1155Amount).eq(balance))
          ).to.be.true;

          expect(fulfillStandardOrderSpy).calledOnce;
        });
      });
    });
  }
);