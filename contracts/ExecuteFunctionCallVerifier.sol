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

contract ExecuteFunctionCallVerifier {
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
    uint256 constant deltax1 = 4634353804617107008461629163901630314391211495822972389441324920284642828587;
    uint256 constant deltax2 = 16770642601600190401158460110572266164509424688459951170390612237121244754882;
    uint256 constant deltay1 = 12719754445632842299716346602114709505962703549385736467355643031903114050255;
    uint256 constant deltay2 = 3090955590090491137446653873425185096131008539772094929431995001609799332577;

    
    uint256 constant IC0x = 4446606300787334488519396228737019620924871555016964435860305456011587704968;
    uint256 constant IC0y = 4370924993566242555488958348491759010157852584483914428846908247848304643938;
    
    uint256 constant IC1x = 10680121573553230801881700031637963520479625475615232408740183862849202988436;
    uint256 constant IC1y = 15805513708811438829590308515347058186674151690963314081033935974279173396645;
    
    uint256 constant IC2x = 15570221759979460122781766765033669714238253821874174341785023751165716811305;
    uint256 constant IC2y = 15049455364413022034520218219678957433667940787128137509970254301613011977552;
    
    uint256 constant IC3x = 10012168517540518628860954429903730912042009306023157273052131788413353859071;
    uint256 constant IC3y = 19142908129317345062853120438820013136001711092508474101914649217401634699641;
    
    uint256 constant IC4x = 18834680750533163942849733340678252340404726966491497995842929042753497243805;
    uint256 constant IC4y = 1799707238252825632014830419633440609381179878589052004797979773987957965013;
    
    uint256 constant IC5x = 19319195102836639031053710942344228657023493846603041622877386379067785336142;
    uint256 constant IC5y = 8617425178646320857129063029426014161545154031311058080238752668036150352142;
    
    uint256 constant IC6x = 15662346321107637807446273009597375586264737091499077121718020778151010556323;
    uint256 constant IC6y = 11768224669918375893704081422125301648371550757476769336728725870232223516974;
    
    uint256 constant IC7x = 5684601206450507179909342504815534166910605629505154445280761915426815500674;
    uint256 constant IC7y = 14160747283127755959602718323431930713017303081623461286819500582294716807865;
    
    uint256 constant IC8x = 15349442531174200970855742552001470325616376107544394073571909428086193707498;
    uint256 constant IC8y = 20174948798344139734249432160732196711997336648099382857250016706081922313069;
    
    uint256 constant IC9x = 20324049527492829498896654063209656563252725942732569247549803683199130638017;
    uint256 constant IC9y = 10346980466907648679062761583462294967678164411192129315323016088522575046749;
    
    uint256 constant IC10x = 16449898858430693342930429729072102730774938971266598592710381791321855741277;
    uint256 constant IC10y = 5015853549665477767545867536029878759275862218867070760083900352105457407452;
    
    uint256 constant IC11x = 2830675869786530297425566617905752274348418634684872589445736327132208548729;
    uint256 constant IC11y = 4315497051649317008978111003060995863688576722673807350074930592094771329625;
    
    uint256 constant IC12x = 5480285316135284364283708070584752517365202086075222850081520398602155043908;
    uint256 constant IC12y = 12744345785732136729118851160104915030151203649384161655136162900963670020857;
    
    uint256 constant IC13x = 12236187086755437305161933487686340012899199072853307709097614353996748165070;
    uint256 constant IC13y = 4258400690605219902143565621554527825070712977566125627757938199876944759915;
    
    uint256 constant IC14x = 20462407930525811868783426221867328934737778251567489854847104902639037919563;
    uint256 constant IC14y = 13229351899281362035160488383358594184249653071793044440082405443688125105220;
    
    uint256 constant IC15x = 10074859450986775302828480947631255339753175463364276721105225854481514653909;
    uint256 constant IC15y = 18901261472135816243737389639802623991843017902551238903582620758187257402148;
    
    uint256 constant IC16x = 11212489037284890357224499292965315917991932790806568314928530869713441395917;
    uint256 constant IC16y = 21532810449428636289310638742415680284120291975664491917263043043680914582084;
    
    uint256 constant IC17x = 362760641388171569192283822814814940288673615492621507884808763350585832935;
    uint256 constant IC17y = 105293887799596539190959830163935095825419867337163326432218986417596680099;
    
    uint256 constant IC18x = 16206682270014159551995332826780604568045372870229389809584905091489084112785;
    uint256 constant IC18y = 7504296954719109471749139647983734909569436846915784048737494955345856792745;
    
 
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
