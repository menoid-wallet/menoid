// SPDX-License-Identifier: GPL-3.0
/*
    Copyright 2021 0KIMS association.

    This file is generated with [snarkJS](https://github.com/iden3/snarkjs).

    snarkJS is a free software: you can redistribute it and/or modify it
    under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    snarkJS is distributed in the hope that it will be useful, but WITHOUT
    ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
    or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public
    License for more details.

    You should have received a copy of the GNU General Public License
    along with snarkJS. If not, see <https://www.gnu.org/licenses/>.
*/

pragma solidity >=0.7.0 <0.9.0;

contract CreateNoidAccountVerifier {
    // Scalar field size
    uint256 constant r    = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    // Base field size
    uint256 constant q   = 21888242871839275222246405745257275088696311157297823662689037894645226208583;

    // Verification Key data
    uint256 constant alphax  = 20491192805390485299153009773594534940189261866228447918068658471970481763042;
    uint256 constant alphay  = 9383485363053290200918347156157836566562967994039712273449902621266178545958;
    uint256 constant betax1  = 4252822878758300859123897981450591353533073413197771768651442665752259397132;
    uint256 constant betax2  = 6375614351688725206403948262868962793625744043794305715222011528459656738731;
    uint256 constant betay1  = 21847035105528745403288232691147584728191162732299865338377159692350059136679;
    uint256 constant betay2  = 10505242626370262277552901082094356697409835680220590971873171140371331206856;
    uint256 constant gammax1 = 11559732032986387107991004021392285783925812861821192530917403151452391805634;
    uint256 constant gammax2 = 10857046999023057135944570762232829481370756359578518086990519993285655852781;
    uint256 constant gammay1 = 4082367875863433681332203403145435568316851327593401208105741076214120093531;
    uint256 constant gammay2 = 8495653923123431417604973247489272438418190587263600148770280649306958101930;
    uint256 constant deltax1 = 4832773278781831657997712689574160362998569924721741273209969752211879093317;
    uint256 constant deltax2 = 12574775445537277948956356924993567395786814803730451568338698792392805115299;
    uint256 constant deltay1 = 18642620740411782510989117694968579684086110640060945582189840560293559000529;
    uint256 constant deltay2 = 9588999980807313773037527001763277266971214238009309665493327437837221535494;

    
    uint256 constant IC0x = 6007975771707864538707182833894912015310095499600766070294587420305563249185;
    uint256 constant IC0y = 8542973326943898397329108733842266052845473248103814549292296701686729530517;
    
    uint256 constant IC1x = 15125708193314840343943723810743263907382542927470230424940239597761719660752;
    uint256 constant IC1y = 5531720813837963386141234169655465622231070643976716981406088905638394127226;
    
    uint256 constant IC2x = 12972767507515208837836534250375704470933420434593742439652098378361951285335;
    uint256 constant IC2y = 9934070453564855572237379093890160927102771679325036298295112427028852182530;
    
    uint256 constant IC3x = 4723395033692773940955884818243723349592386591608858786323924807588748743672;
    uint256 constant IC3y = 16615666729926775607493558052777237852617490745868117066262722587227367907352;
    
    uint256 constant IC4x = 18384962499415230837040155360325386171329728332000800935937248063196132254031;
    uint256 constant IC4y = 4933807482080088692330748094379208685533964866772839713344815082874964628981;
    
    uint256 constant IC5x = 14473497528814915761865480865904134005065159247040853532245582638770888857689;
    uint256 constant IC5y = 14581850894715737046617004030909881993660695545304412992505847814609356710068;
    
    uint256 constant IC6x = 3986536782745121319827355269814348572331584828438324072558448501950677277013;
    uint256 constant IC6y = 3852864751110129052646349245660361781561296071159921510218091056742161431701;
    
    uint256 constant IC7x = 16706696079200733228586383669298201835600190403518428322508235298071050025985;
    uint256 constant IC7y = 12172117793386922277848221391571985085256919783030040897172904911475578622480;
    
    uint256 constant IC8x = 8591966255093715773484851443845947040879577901928841837054114031908913830717;
    uint256 constant IC8y = 10392529119856698743355733905761309471156109853784506567223304523806275857432;
    
    uint256 constant IC9x = 5933619236296915093188997588033492981903852640983501578430112478271254079166;
    uint256 constant IC9y = 20654026101757309247587873598364493062805711418683040876699209585996151116576;
    
    uint256 constant IC10x = 20605768887128901913634857816532818864234605349256436133256222651888830104135;
    uint256 constant IC10y = 18949871437589542845100310359417734038950226336148584445011323784255324872669;
    
    uint256 constant IC11x = 7002935389746248352054214481003206547162891372845094890497507935057261343206;
    uint256 constant IC11y = 2589789430563399819890914768695528314089363810820156239428913691306237850230;
    
    uint256 constant IC12x = 10107103307963469157013911379267397384082915037206071886178964508568973327967;
    uint256 constant IC12y = 6008582351323221350040314216372895351372986758828364298946550237797332895070;
    
    uint256 constant IC13x = 9705465375366666272568332193718331809592876682064969158482385619945576080746;
    uint256 constant IC13y = 9130228582172840822130443508140838763266201621364393808588815661514238423704;
    
    uint256 constant IC14x = 9089918002181598224998589656199752939049718400995533815600410193435581386170;
    uint256 constant IC14y = 16757502801325813942384521057182600928875272702689112515805988784496096547400;
    
    uint256 constant IC15x = 2887606185135054879553799626580488204174188355803604050934960612990297262153;
    uint256 constant IC15y = 18458331886446931659639717606411413135754082063534099799894894232885806111529;
    
    uint256 constant IC16x = 11335064178343388944599294314562120921166406311687334860073912531428011958290;
    uint256 constant IC16y = 1920215799352563896422811608078856276460991980428535935648340864532376997997;
    
    uint256 constant IC17x = 3728841926975717212932669030163030364792883102447903716763375916635774990436;
    uint256 constant IC17y = 10993245402648492697335249228442105250316984320640529548666688813212175570757;
    
    uint256 constant IC18x = 18968668415065372378638864145118139665100989346040350005413915585612921384035;
    uint256 constant IC18y = 15246844751970452593510186689635078179087033009611431352899929232057768786858;
    
 
    // Memory data
    uint16 constant pVk = 0;
    uint16 constant pPairing = 128;

    uint16 constant pLastMem = 896;

    function verifyProof(uint[2] calldata _pA, uint[2][2] calldata _pB, uint[2] calldata _pC, uint[18] calldata _pubSignals) public view returns (bool) {
        assembly {
            function checkField(v) {
                if iszero(lt(v, r)) {
                    mstore(0, 0)
                    return(0, 0x20)
                }
            }
            
            // G1 function to multiply a G1 value(x,y) to value in an address
            function g1_mulAccC(pR, x, y, s) {
                let success
                let mIn := mload(0x40)
                mstore(mIn, x)
                mstore(add(mIn, 32), y)
                mstore(add(mIn, 64), s)

                success := staticcall(sub(gas(), 2000), 7, mIn, 96, mIn, 64)

                if iszero(success) {
                    mstore(0, 0)
                    return(0, 0x20)
                }

                mstore(add(mIn, 64), mload(pR))
                mstore(add(mIn, 96), mload(add(pR, 32)))

                success := staticcall(sub(gas(), 2000), 6, mIn, 128, pR, 64)

                if iszero(success) {
                    mstore(0, 0)
                    return(0, 0x20)
                }
            }

            function checkPairing(pA, pB, pC, pubSignals, pMem) -> isOk {
                let _pPairing := add(pMem, pPairing)
                let _pVk := add(pMem, pVk)

                mstore(_pVk, IC0x)
                mstore(add(_pVk, 32), IC0y)

                // Compute the linear combination vk_x
                
                g1_mulAccC(_pVk, IC1x, IC1y, calldataload(add(pubSignals, 0)))
                
                g1_mulAccC(_pVk, IC2x, IC2y, calldataload(add(pubSignals, 32)))
                
                g1_mulAccC(_pVk, IC3x, IC3y, calldataload(add(pubSignals, 64)))
                
                g1_mulAccC(_pVk, IC4x, IC4y, calldataload(add(pubSignals, 96)))
                
                g1_mulAccC(_pVk, IC5x, IC5y, calldataload(add(pubSignals, 128)))
                
                g1_mulAccC(_pVk, IC6x, IC6y, calldataload(add(pubSignals, 160)))
                
                g1_mulAccC(_pVk, IC7x, IC7y, calldataload(add(pubSignals, 192)))
                
                g1_mulAccC(_pVk, IC8x, IC8y, calldataload(add(pubSignals, 224)))
                
                g1_mulAccC(_pVk, IC9x, IC9y, calldataload(add(pubSignals, 256)))
                
                g1_mulAccC(_pVk, IC10x, IC10y, calldataload(add(pubSignals, 288)))
                
                g1_mulAccC(_pVk, IC11x, IC11y, calldataload(add(pubSignals, 320)))
                
                g1_mulAccC(_pVk, IC12x, IC12y, calldataload(add(pubSignals, 352)))
                
                g1_mulAccC(_pVk, IC13x, IC13y, calldataload(add(pubSignals, 384)))
                
                g1_mulAccC(_pVk, IC14x, IC14y, calldataload(add(pubSignals, 416)))
                
                g1_mulAccC(_pVk, IC15x, IC15y, calldataload(add(pubSignals, 448)))
                
                g1_mulAccC(_pVk, IC16x, IC16y, calldataload(add(pubSignals, 480)))
                
                g1_mulAccC(_pVk, IC17x, IC17y, calldataload(add(pubSignals, 512)))
                
                g1_mulAccC(_pVk, IC18x, IC18y, calldataload(add(pubSignals, 544)))
                

                // -A
                mstore(_pPairing, calldataload(pA))
                mstore(add(_pPairing, 32), mod(sub(q, calldataload(add(pA, 32))), q))

                // B
                mstore(add(_pPairing, 64), calldataload(pB))
                mstore(add(_pPairing, 96), calldataload(add(pB, 32)))
                mstore(add(_pPairing, 128), calldataload(add(pB, 64)))
                mstore(add(_pPairing, 160), calldataload(add(pB, 96)))

                // alpha1
                mstore(add(_pPairing, 192), alphax)
                mstore(add(_pPairing, 224), alphay)

                // beta2
                mstore(add(_pPairing, 256), betax1)
                mstore(add(_pPairing, 288), betax2)
                mstore(add(_pPairing, 320), betay1)
                mstore(add(_pPairing, 352), betay2)

                // vk_x
                mstore(add(_pPairing, 384), mload(add(pMem, pVk)))
                mstore(add(_pPairing, 416), mload(add(pMem, add(pVk, 32))))


                // gamma2
                mstore(add(_pPairing, 448), gammax1)
                mstore(add(_pPairing, 480), gammax2)
                mstore(add(_pPairing, 512), gammay1)
                mstore(add(_pPairing, 544), gammay2)

                // C
                mstore(add(_pPairing, 576), calldataload(pC))
                mstore(add(_pPairing, 608), calldataload(add(pC, 32)))

                // delta2
                mstore(add(_pPairing, 640), deltax1)
                mstore(add(_pPairing, 672), deltax2)
                mstore(add(_pPairing, 704), deltay1)
                mstore(add(_pPairing, 736), deltay2)


                let success := staticcall(sub(gas(), 2000), 8, _pPairing, 768, _pPairing, 0x20)

                isOk := and(success, mload(_pPairing))
            }

            let pMem := mload(0x40)
            mstore(0x40, add(pMem, pLastMem))

            // Validate that all evaluations ∈ F
            
            checkField(calldataload(add(_pubSignals, 0)))
            
            checkField(calldataload(add(_pubSignals, 32)))
            
            checkField(calldataload(add(_pubSignals, 64)))
            
            checkField(calldataload(add(_pubSignals, 96)))
            
            checkField(calldataload(add(_pubSignals, 128)))
            
            checkField(calldataload(add(_pubSignals, 160)))
            
            checkField(calldataload(add(_pubSignals, 192)))
            
            checkField(calldataload(add(_pubSignals, 224)))
            
            checkField(calldataload(add(_pubSignals, 256)))
            
            checkField(calldataload(add(_pubSignals, 288)))
            
            checkField(calldataload(add(_pubSignals, 320)))
            
            checkField(calldataload(add(_pubSignals, 352)))
            
            checkField(calldataload(add(_pubSignals, 384)))
            
            checkField(calldataload(add(_pubSignals, 416)))
            
            checkField(calldataload(add(_pubSignals, 448)))
            
            checkField(calldataload(add(_pubSignals, 480)))
            
            checkField(calldataload(add(_pubSignals, 512)))
            
            checkField(calldataload(add(_pubSignals, 544)))
            

            // Validate all evaluations
            let isValid := checkPairing(_pA, _pB, _pC, _pubSignals, pMem)

            mstore(0, isValid)
             return(0, 0x20)
         }
     }
 }
